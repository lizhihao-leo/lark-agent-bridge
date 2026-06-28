import { config } from './config.js'
import { logger } from './logger.js'
import { startConsumer } from './lark/consume.js'
import { reply, recall, replyImage } from './lark/reply.js'
import { react } from './lark/reactions.js'
import { extractLocalImages } from './lark/images.js'
import { buildCard, type CardPhase, type ToolEntry } from './lark/card.js'
import { sendCardReply, CardPatcher } from './lark/card-send.js'
import { startCardActionConsumer, type CardActionEvent } from './lark/card-action-consume.js'
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

  // Emoji ack: visible signal of "received" within ~200 ms, before the
  // LLM round-trip starts. Best-effort and fire-and-forget — we don't
  // want a reaction-API hiccup to delay the actual processing.
  if (config.ACK_EMOJI) {
    void react(evt.message_id, config.ACK_EMOJI)
  }

  store.appendMessage(evt.chat_id, 'user', userText)

  if (config.BACKEND === 'claude-code') {
    await handleClaudeCode(evt, userText)
    return
  }

  // Default backend: one Anthropic-SDK HTTP call with our SQLite-backed
  // history. Tools (if ENABLE_TOOLS=true) loop inside `chat()`.
  let body: string
  let format: 'text' | 'markdown' = 'text'
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

/**
 * Claude Code backend with optional streaming-card UI.
 *
 * Path A (default, STREAMING_CARD=true): send an interactive card as the
 * reply, PATCH it as the agent loop streams tool-use / text events.
 *
 * Path B (STREAMING_CARD=false or card send failed): legacy text path,
 * preserves the Phase 7 "⏳ 思考中…" placeholder + Phase 8 image replies.
 */
async function handleClaudeCode(evt: FeishuMessageEvent, userText: string): Promise<void> {
  if (config.STREAMING_CARD) {
    const ok = await tryStreamingCard(evt, userText)
    if (ok) return
    // Fall through to legacy path on send failure.
    logger.warn({ chat: evt.chat_id }, 'streaming card path failed, falling back to text')
  }

  // ---- Legacy text path ----
  let placeholderId: string | undefined
  if (config.SHOW_THINKING_PLACEHOLDER) {
    const r = await reply({
      messageId: evt.message_id,
      body: '⏳ 思考中…',
      format: 'text',
    })
    placeholderId = r.replyMessageId
  }

  let body: string
  try {
    const result = await runClaudeCode(evt.chat_id, userText, (p) => logProgress(evt.chat_id, p))
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

  let format: 'text' | 'markdown' = 'text'
  if (/[`*#>\-_]|\n/.test(body)) format = 'markdown'

  store.appendMessage(evt.chat_id, 'assistant', body)

  const { images, skipped, stripped } = extractLocalImages(body, config.CLAUDE_CODE_SANDBOX)
  if (skipped.length > 0) {
    logger.warn(
      {
        chat: evt.chat_id,
        skipped: skipped.map((s) => ({ reason: s.reason, ref: s.ref.slice(0, 80) })),
      },
      'image refs skipped (kept as markdown)',
    )
  }

  const textBody = stripped.trim()
  if (textBody) {
    await reply({ messageId: evt.message_id, body: textBody, format })
  } else if (images.length === 0) {
    await reply({ messageId: evt.message_id, body: '(空回复)', format: 'text' })
  }

  for (const img of images) {
    logger.info({ chat: evt.chat_id, image: img.relPath, alt: img.alt }, 'sending image reply')
    const r = await replyImage({
      messageId: evt.message_id,
      image: img.relPath,
      cwd: config.CLAUDE_CODE_SANDBOX,
    })
    if (!r.ok) logger.warn({ chat: evt.chat_id, image: img.relPath }, 'image reply failed')
  }

  if (placeholderId) {
    recall(placeholderId).catch((err) =>
      logger.warn({ err }, 'placeholder recall failed (non-fatal)'),
    )
  }
}

/**
 * Streaming-card path. Returns `true` on success, `false` if the card
 * couldn't even be sent (so the caller can fall back to the text path).
 */
async function tryStreamingCard(evt: FeishuMessageEvent, userText: string): Promise<boolean> {
  // 1. Send the initial "thinking" card.
  const initialCard = buildCard({
    phase: 'thinking',
    tools: [],
    body: '',
    showActions: false,
  })
  const sendResult = await sendCardReply(evt.message_id, initialCard)
  if (!sendResult.ok || !sendResult.messageId) return false
  const cardMsgId = sendResult.messageId
  const patcher = new CardPatcher(cardMsgId, config.STREAMING_CARD_MIN_INTERVAL_MS)

  // 2. Run Claude Code, queue card updates from each progress event.
  const tools: ToolEntry[] = []
  const toolIdxById = new Map<string, number>()
  let partialBody = ''
  const startedAt = Date.now()

  const snapshot = (phase: CardPhase, opts: { final?: boolean; costUsd?: number } = {}) =>
    buildCard({
      phase,
      tools,
      body: partialBody,
      durationSec: (Date.now() - startedAt) / 1000,
      ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
      showActions: phase === 'done' || phase === 'error',
    })

  const onProgress = (p: ClaudeCodeProgress): void => {
    logProgress(evt.chat_id, p)
    switch (p.kind) {
      case 'tool_use': {
        toolIdxById.set(p.toolUseId, tools.length)
        tools.push({ tool: p.tool, brief: p.brief })
        patcher.queue(snapshot('running'))
        break
      }
      case 'tool_result': {
        const idx = toolIdxById.get(p.toolUseId)
        if (idx !== undefined && tools[idx]) tools[idx]!.ok = p.ok
        patcher.queue(snapshot('running'))
        break
      }
      case 'text': {
        partialBody += p.text
        patcher.queue(snapshot('running'))
        break
      }
    }
  }

  let body: string
  let costUsd: number | undefined
  let stopReason: string | undefined
  try {
    const result = await runClaudeCode(evt.chat_id, userText, onProgress)
    body = result.text
    costUsd = result.costUsd
    stopReason = result.stopReason
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
    stopReason = 'error'
  }

  store.appendMessage(evt.chat_id, 'assistant', body)

  // 3. Process images and replace partialBody with the canonical body
  //    (cleaned of local-file image refs) before flushing.
  const { images, skipped, stripped } = extractLocalImages(body, config.CLAUDE_CODE_SANDBOX)
  if (skipped.length > 0) {
    logger.warn(
      {
        chat: evt.chat_id,
        skipped: skipped.map((s) => ({ reason: s.reason, ref: s.ref.slice(0, 80) })),
      },
      'image refs skipped (kept as markdown)',
    )
  }
  partialBody = stripped || body

  const finalPhase: CardPhase = stopReason === 'error' ? 'error' : 'done'
  await patcher.flush(snapshot(finalPhase, costUsd !== undefined ? { costUsd } : {}))

  // 4. Image replies still go as separate messages (Phase 8 unchanged).
  for (const img of images) {
    logger.info({ chat: evt.chat_id, image: img.relPath, alt: img.alt }, 'sending image reply')
    const r = await replyImage({
      messageId: evt.message_id,
      image: img.relPath,
      cwd: config.CLAUDE_CODE_SANDBOX,
    })
    if (!r.ok) logger.warn({ chat: evt.chat_id, image: img.relPath }, 'image reply failed')
  }
  return true
}

/** Pure-logging onProgress used by both paths. */
function logProgress(chatId: string, p: ClaudeCodeProgress): void {
  switch (p.kind) {
    case 'tool_use':
      logger.info(
        { chat: chatId, tool: p.tool, brief: p.brief.slice(0, 80) },
        'claude-code tool_use',
      )
      break
    case 'tool_result':
      logger.debug(
        { chat: chatId, tool: p.tool, ok: p.ok, len: p.preview.length },
        'claude-code tool_result',
      )
      break
    case 'text':
      logger.debug({ chat: chatId, preview: p.text.slice(0, 80) }, 'claude-code partial text')
      break
  }
}

export function run(): { stop: () => Promise<void> } {
  logger.info(
    {
      backend: config.BACKEND,
      model: config.ANTHROPIC_MODEL,
      key: config.LARK_EVENT_KEY,
      groupTrigger: config.GROUP_TRIGGER,
      streamingCard: config.BACKEND === 'claude-code' ? config.STREAMING_CARD : undefined,
      cardCallback: config.ENABLE_CARD_CALLBACK,
      ackEmoji: config.ACK_EMOJI || null,
      sandbox: config.BACKEND === 'claude-code' ? config.CLAUDE_CODE_SANDBOX : undefined,
    },
    'bridge starting',
  )

  const { stop: stopMsgConsumer } = startConsumer({
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

  // Optional second consumer for card-action callbacks. Requires the
  // app's Developer Console to have "Callback Configuration" enabled —
  // see docs/architecture.md for setup. We always wire the handler when
  // ENABLE_CARD_CALLBACK is on, even if the user hasn't enabled the
  // console toggle (the lark-cli consumer will simply receive nothing).
  let stopCardConsumer: (() => Promise<void>) | undefined
  if (config.ENABLE_CARD_CALLBACK) {
    const h = startCardActionConsumer(onCardAction)
    stopCardConsumer = h.stop
  }

  return {
    stop: async () => {
      clearInterval(pruneTimer)
      await stopMsgConsumer()
      if (stopCardConsumer) await stopCardConsumer()
      store.close()
    },
  }
}

/**
 * Handle a card button click. Currently:
 *   - `regenerate` → re-run the last user message in this chat as a new
 *     LLM turn (synthesise a fresh FeishuMessageEvent and pass it to
 *     `handle()`). Bypasses the group-mention filter — the user already
 *     opted in by clicking the button.
 */
async function onCardAction(action: CardActionEvent): Promise<void> {
  const name = String(action.actionValue['action'] ?? '')
  logger.info(
    {
      chat: action.chatId,
      msg: action.messageId,
      operator: action.operatorId,
      name,
      tag: action.actionTag,
    },
    'card action received',
  )
  if (name !== 'regenerate') {
    logger.debug({ name }, 'card action ignored (unknown name)')
    return
  }
  // Walk recent history to find the most recent user turn — that's what
  // we re-run. We deliberately ignore the previous assistant turn (don't
  // delete it; just send a fresh one in reply).
  const history = store.history(action.chatId, 8)
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    logger.warn({ chat: action.chatId }, 'regenerate: no user message in history')
    return
  }
  // Send a "regenerate" prefix so Claude Code sees this is a retry,
  // not a fresh question — it can decide to take a different angle.
  const synthetic: FeishuMessageEvent = {
    type: 'im.message.receive_v1',
    event_id: `regenerate-${action.messageId}-${Date.now()}`,
    id: action.messageId,
    message_id: action.messageId,
    chat_id: action.chatId,
    // p2p bypasses the group-mention filter; even if the original chat
    // is a group, the operator already opted in by clicking.
    chat_type: 'p2p',
    message_type: 'text',
    sender_id: action.operatorId,
    content: `请重新回答上一个问题（用不同的角度或更详尽的内容）：${lastUser.content}`,
    timestamp: String(Date.now()),
    create_time: String(Date.now()),
  }
  await handle(synthetic)
}
