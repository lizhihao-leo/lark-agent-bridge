import { config } from './config.js'
import { logger } from './logger.js'
import { startConsumer } from './lark/consume.js'
import { reply, recall, replyImage } from './lark/reply.js'
import { extractLocalImages } from './lark/images.js'
import { chat } from './llm.js'
import { runClaudeCode, type ClaudeCodeProgress } from './llm-claude-code.js'
import { Store } from './store.js'
import type { FeishuMessageEvent } from './lark/types.js'

const store = new Store(config.STORE_PATH)

function prune(): void {
  const removed = store.pruneSeenEvents(config.SEEN_EVENT_TTL_DAYS * 24 * 3600 * 1000)
  if (removed > 0) logger.debug({ removed }, 'pruned seen_events')
}
prune()
const pruneTimer = setInterval(prune, 3600 * 1000)
pruneTimer.unref()

/**
 * Decide whether a group message should trigger the bot. P2P always triggers.
 *
 * The exact mention semantics depend on Feishu's content normalisation done
 * by lark-cli: for `@bot` messages, the content string is pre-pended with
 * `@DisplayName ` (or the bot's @-handle). We treat any leading '@' as a
 * mention for simplicity — under the default delivery filter Feishu only
 * pushes group messages where the bot is involved, so this is safe.
 */
function shouldHandleGroup(content: string): boolean {
  switch (config.GROUP_TRIGGER) {
    case 'off':
      return false
    case 'all':
      return true
    case 'mention':
      return content.trimStart().startsWith('@')
  }
}

/** Strip the bot's @-mention prefix so the LLM doesn't see it. */
function stripMention(content: string): string {
  let s = content.trimStart()
  if (config.BOT_AT_PREFIX && s.startsWith(config.BOT_AT_PREFIX)) {
    s = s.slice(config.BOT_AT_PREFIX.length).trimStart()
  } else if (s.startsWith('@')) {
    // Generic strip: '@something ' up to first space.
    const ix = s.indexOf(' ')
    s = ix === -1 ? '' : s.slice(ix + 1)
  }
  return s
}

async function handle(evt: FeishuMessageEvent): Promise<void> {
  const isGroup = evt.chat_type === 'group'
  const rawContent = String(evt.content ?? '')

  // Non-text payloads: politely tell the user we don't speak that yet.
  if (evt.message_type !== 'text') {
    if (isGroup && !shouldHandleGroup(rawContent)) return
    await reply({
      messageId: evt.message_id,
      body: `(暂不支持 \`${evt.message_type}\` 类型消息,当前版本只处理文本。)`,
      format: 'markdown',
    })
    return
  }

  // Group filter.
  if (isGroup && !shouldHandleGroup(rawContent)) {
    logger.debug({ chat: evt.chat_id, preview: rawContent.slice(0, 40) }, 'group msg ignored')
    return
  }

  if (isGroup) {
    logger.trace({ chat: evt.chat_id, raw: rawContent.slice(0, 120) }, 'group raw content')
  }

  const userText = (isGroup ? stripMention(rawContent) : rawContent).slice(
    0,
    config.MAX_INPUT_CHARS,
  )
  if (!userText.trim()) return

  logger.info(
    {
      chat: evt.chat_id,
      chatType: evt.chat_type,
      from: evt.sender_id,
      preview: userText.slice(0, 80),
    },
    'incoming message',
  )

  store.appendMessage(evt.chat_id, 'user', userText)

  let body: string
  let format: 'text' | 'markdown' = 'text'

  if (config.BACKEND === 'claude-code') {
    // Send an immediate placeholder so the user sees activity within a
    // second. We'll recall it after the final reply lands (best-effort).
    let placeholderId: string | undefined
    if (config.SHOW_THINKING_PLACEHOLDER) {
      const r = await reply({
        messageId: evt.message_id,
        body: '⏳ 思考中…',
        format: 'text',
      })
      placeholderId = r.replyMessageId
    }

    // Claude Code manages its own session/history via --resume; we still
    // record the turn in our SQLite store for audit + dedup. Stream progress
    // events to the logger so operators can see tool calls in real time.
    try {
      const onProgress = (p: ClaudeCodeProgress): void => {
        switch (p.kind) {
          case 'tool_use':
            logger.info(
              { chat: evt.chat_id, tool: p.tool, brief: p.brief.slice(0, 80) },
              'claude-code tool_use',
            )
            break
          case 'tool_result':
            logger.debug(
              { chat: evt.chat_id, tool: p.tool, ok: p.ok, len: p.preview.length },
              'claude-code tool_result',
            )
            break
          case 'text':
            logger.debug(
              { chat: evt.chat_id, preview: p.text.slice(0, 80) },
              'claude-code partial text',
            )
            break
        }
      }
      const result = await runClaudeCode(evt.chat_id, userText, onProgress)
      body = result.text
      logger.info(
        {
          chat: evt.chat_id,
          sec: result.durationSec.toFixed(1),
          cost: result.costUsd,
          stop: result.stopReason,
          session: result.sessionId.slice(0, 8),
          toolCalls: result.toolCalls,
        },
        'claude-code done',
      )
    } catch (err) {
      const e = err as { message?: string }
      logger.error({ err: e.message }, 'claude-code threw')
      body = `(Claude Code 失败: ${e.message ?? String(err)})`
    }

    // Heuristic: if the response looks like markdown, render as markdown.
    if (/[`*#>\-_]|\n/.test(body)) format = 'markdown'

    store.appendMessage(evt.chat_id, 'assistant', body)

    // Image extraction: Claude Code can produce files in the sandbox and
    // reference them via `![](path)` markdown. Feishu won't render those as
    // images, so we extract the local-file refs, send a text reply with the
    // refs replaced by `[图片: …]` captions, then send each image separately
    // as an image message. URL/img_xxx refs are left in the body — lark-cli's
    // markdown mode resolves URLs natively.
    const { images, skipped, stripped } = extractLocalImages(body, config.CLAUDE_CODE_SANDBOX)
    if (skipped.length > 0) {
      logger.warn(
        { chat: evt.chat_id, skipped: skipped.map((s) => ({ reason: s.reason, ref: s.ref.slice(0, 80) })) },
        'image refs skipped (kept as markdown)',
      )
    }

    const textBody = stripped.trim()
    if (textBody) {
      await reply({ messageId: evt.message_id, body: textBody, format })
    } else if (images.length === 0) {
      // No images to send AND nothing left to say — surface an explicit note
      // so the user doesn't think we silently dropped the turn.
      await reply({ messageId: evt.message_id, body: '(空回复)', format: 'text' })
    }
    // If stripped is empty but we have images, skip the text reply entirely —
    // the images themselves are the message.

    for (const img of images) {
      logger.info({ chat: evt.chat_id, image: img.relPath, alt: img.alt }, 'sending image reply')
      const r = await replyImage({
        messageId: evt.message_id,
        image: img.relPath,
        cwd: config.CLAUDE_CODE_SANDBOX,
      })
      if (!r.ok) {
        logger.warn({ chat: evt.chat_id, image: img.relPath }, 'image reply failed (continuing)')
      }
    }

    // Best-effort recall of the placeholder. Done after the final reply lands
    // so the user always has something to read.
    if (placeholderId) {
      recall(placeholderId).catch((err) =>
        logger.warn({ err }, 'placeholder recall failed (non-fatal)'),
      )
    }
    return
  }

  // Default backend: one Anthropic-SDK HTTP call with our SQLite-backed
  // history. Tools (if ENABLE_TOOLS=true) loop inside `chat()`.
  const history = store.history(evt.chat_id, config.MAX_HISTORY_TURNS * 2)
  try {
    const result = await chat(history)
    body = result.text
  } catch (err) {
    const e = err as { status?: number; message?: string }
    logger.error({ status: e.status, msg: e.message }, 'LLM call failed')
    body = `(调用模型失败: ${e.status ?? ''} ${e.message ?? String(err)})`
  }

  if (/[`*#>\-_]|\n/.test(body)) format = 'markdown'

  store.appendMessage(evt.chat_id, 'assistant', body)
  await reply({ messageId: evt.message_id, body, format })
}

export function run(): { stop: () => Promise<void> } {
  logger.info(
    {
      backend: config.BACKEND,
      model: config.ANTHROPIC_MODEL,
      key: config.LARK_EVENT_KEY,
      groupTrigger: config.GROUP_TRIGGER,
      sandbox: config.BACKEND === 'claude-code' ? config.CLAUDE_CODE_SANDBOX : undefined,
    },
    'bridge starting',
  )

  const { stop: stopConsumer } = startConsumer({
    eventKey: config.LARK_EVENT_KEY,
    as: config.LARK_EVENT_AS,
    onEvent: (evt) => {
      if (!store.claimEvent(evt.event_id)) {
        logger.debug({ event_id: evt.event_id }, 'duplicate event, skipped')
        return
      }
      handle(evt).catch((err) => logger.error({ err }, 'handle threw'))
    },
  })

  return {
    stop: async () => {
      clearInterval(pruneTimer)
      await stopConsumer()
      store.close()
    },
  }
}
