import type { ChatMessage } from './llm.js'
import { config } from './config.js'

/**
 * In-memory per-chat history. Phase 2 will swap this for a SQLite-backed
 * store with idempotency tracking; the interface here is the seam.
 */
export class SessionStore {
  private readonly map = new Map<string, ChatMessage[]>()

  get(chatId: string): ChatMessage[] {
    return this.map.get(chatId) ?? []
  }

  append(chatId: string, msg: ChatMessage): ChatMessage[] {
    const history = this.map.get(chatId) ?? []
    history.push(msg)
    const limit = config.MAX_HISTORY_TURNS * 2 // user+assistant per turn
    while (history.length > limit) history.shift()
    this.map.set(chatId, history)
    return history
  }
}
