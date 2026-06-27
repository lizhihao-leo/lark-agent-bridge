import { config } from './config.js'
import { logger } from './logger.js'
import { startConsumer } from './lark/consume.js'
import { replyText } from './lark/reply.js'
import { chat } from './llm.js'
import { Store } from './store.js'
import type { FeishuMessageEvent } from './lark/types.js'

const store = new Store(config.STORE_PATH)

// Prune dedup entries on startup and hourly thereafter.
function prune(): void {
  const removed = store.pruneSeenEvents(config.SEEN_EVENT_TTL_DAYS * 24 * 3600 * 1000)
  if (removed > 0) logger.debug({ removed }, 'pruned seen_events')
}
prune()
const pruneTimer = setInterval(prune, 3600 * 1000)
pruneTimer.unref()

async function handle(evt: FeishuMessageEvent): Promise<void> {
  if (evt.message_type !== 'text') {
    await replyText({
      messageId: evt.message_id,
      text: `(暂不支持 ${evt.message_type} 类型,请发送文本消息)`,
    })
    return
  }

  const userText = String(evt.content ?? '').slice(0, config.MAX_INPUT_CHARS)
  if (!userText.trim()) return

  logger.info(
    {
      chat: evt.chat_id,
      from: evt.sender_id,
      preview: userText.slice(0, 80),
    },
    'incoming message',
  )

  store.appendMessage(evt.chat_id, 'user', userText)
  const history = store.history(evt.chat_id, config.MAX_HISTORY_TURNS * 2)

  let reply: string
  try {
    const result = await chat(history)
    reply = result.text
  } catch (err) {
    const e = err as { status?: number; message?: string }
    logger.error({ status: e.status, msg: e.message }, 'LLM call failed')
    reply = `(调用模型失败: ${e.status ?? ''} ${e.message ?? String(err)})`
  }

  store.appendMessage(evt.chat_id, 'assistant', reply)
  await replyText({ messageId: evt.message_id, text: reply })
}

export function run(): { stop: () => Promise<void> } {
  logger.info({ model: config.ANTHROPIC_MODEL, key: config.LARK_EVENT_KEY }, 'bridge starting')

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
