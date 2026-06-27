import { config } from './config.js'
import { logger } from './logger.js'
import { startConsumer } from './lark/consume.js'
import { replyText } from './lark/reply.js'
import { chat } from './llm.js'
import { SessionStore } from './sessions.js'
import type { FeishuMessageEvent } from './lark/types.js'

const sessions = new SessionStore()
const seenEvents = new Set<string>()
const SEEN_LIMIT = 5000 // simple LRU-ish bound; Phase 2 replaces with SQLite

function rememberEvent(id: string): boolean {
  if (seenEvents.has(id)) return false
  seenEvents.add(id)
  if (seenEvents.size > SEEN_LIMIT) {
    // Drop the oldest ~1k entries; Set iteration order is insertion order.
    const drop = Array.from(seenEvents).slice(0, 1000)
    for (const k of drop) seenEvents.delete(k)
  }
  return true
}

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

  const history = sessions.append(evt.chat_id, { role: 'user', content: userText })

  let reply: string
  try {
    const result = await chat(history)
    reply = result.text
  } catch (err) {
    const e = err as { status?: number; message?: string }
    logger.error({ status: e.status, msg: e.message }, 'LLM call failed')
    reply = `(调用模型失败: ${e.status ?? ''} ${e.message ?? String(err)})`
  }

  sessions.append(evt.chat_id, { role: 'assistant', content: reply })
  await replyText({ messageId: evt.message_id, text: reply })
}

export function run(): { stop: () => Promise<void> } {
  logger.info({ model: config.ANTHROPIC_MODEL, key: config.LARK_EVENT_KEY }, 'bridge starting')

  const { stop } = startConsumer({
    eventKey: config.LARK_EVENT_KEY,
    as: config.LARK_EVENT_AS,
    onEvent: (evt) => {
      if (!rememberEvent(evt.event_id)) {
        logger.debug({ event_id: evt.event_id }, 'duplicate event, skipped')
        return
      }
      handle(evt).catch((err) => logger.error({ err }, 'handle threw'))
    },
  })

  return { stop }
}
