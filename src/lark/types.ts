/**
 * Real-world event shape captured from `lark-cli event consume im.message.receive_v1`.
 * Fields are flat at root — there is no `event`/`header` wrapper despite what some
 * docs imply. `content` is *pre-rendered* by lark-cli to a human-readable string,
 * so consumers do NOT need to `JSON.parse(content).text` again.
 */
export interface FeishuMessageEvent {
  type: 'im.message.receive_v1'
  event_id: string
  /** Alias of message_id, kept for compatibility. */
  id: string
  message_id: string
  chat_id: string
  chat_type: 'p2p' | 'group'
  message_type: string
  sender_id: string
  content: string
  /** ms timestamp string */
  timestamp: string
  /** ms timestamp string */
  create_time: string
}

export function isFeishuMessageEvent(v: unknown): v is FeishuMessageEvent {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: unknown }).type === 'im.message.receive_v1' &&
    typeof (v as { message_id?: unknown }).message_id === 'string'
  )
}
