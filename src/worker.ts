import { config } from './config.js'
import { logger } from './logger.js'
import { startConsumer } from './lark/consume.js'
import { reply } from './lark/reply.js'
import { chat } from './llm.js'
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
  const history = store.history(evt.chat_id, config.MAX_HISTORY_TURNS * 2)

  let body: string
  let format: 'text' | 'markdown' = 'text'
  try {
    const result = await chat(history)
    body = result.text
    // Heuristic: if the LLM included markdown sigils, render as markdown.
    if (/[`*#>\-_]|\n/.test(body)) format = 'markdown'
  } catch (err) {
    const e = err as { status?: number; message?: string }
    logger.error({ status: e.status, msg: e.message }, 'LLM call failed')
    body = `(调用模型失败: ${e.status ?? ''} ${e.message ?? String(err)})`
  }

  store.appendMessage(evt.chat_id, 'assistant', body)
  await reply({ messageId: evt.message_id, body, format })
}

export function run(): { stop: () => Promise<void> } {
  logger.info(
    {
      model: config.ANTHROPIC_MODEL,
      key: config.LARK_EVENT_KEY,
      groupTrigger: config.GROUP_TRIGGER,
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
