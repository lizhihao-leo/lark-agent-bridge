import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { logger } from './logger.js'

/**
 * Persistent state: per-chat history + event dedup. Survives restarts so we
 * don't double-handle messages Feishu retries during a brief outage.
 *
 * Schema is intentionally minimal — sessions are append-only and truncated
 * lazily at read time; dedup is a bounded ring (latest N event_ids).
 */

export interface StoredMessage {
  role: 'user' | 'assistant'
  content: string
}

export class Store {
  private readonly db: Database.Database

  constructor(path: string) {
    const abs = resolve(path)
    mkdirSync(dirname(abs), { recursive: true })
    this.db = new Database(abs)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_created
        ON messages (chat_id, id DESC);

      CREATE TABLE IF NOT EXISTS seen_events (
        event_id    TEXT PRIMARY KEY,
        seen_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_seen_events_seen_at
        ON seen_events (seen_at);

      -- Per-chat key/value settings (e.g. sandbox on/off). Extensible:
      -- new functional commands can stash flags here without a migration.
      CREATE TABLE IF NOT EXISTS chat_settings (
        chat_id     TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (chat_id, key)
      );

      -- Per-chat rolling stats for /status: turn count + cumulative cost.
      CREATE TABLE IF NOT EXISTS chat_stats (
        chat_id     TEXT PRIMARY KEY,
        turns       INTEGER NOT NULL DEFAULT 0,
        cost_usd    REAL NOT NULL DEFAULT 0
      );
    `)
    logger.info({ path: abs }, 'sqlite store ready')
  }

  /** Read a per-chat setting, or `undefined` if unset. */
  getSetting(chatId: string, key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM chat_settings WHERE chat_id = ? AND key = ?')
      .get(chatId, key) as { value: string } | undefined
    return row?.value
  }

  /** Upsert a per-chat setting. */
  setSetting(chatId: string, key: string, value: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO chat_settings (chat_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(chatId, key, value, now)
  }

  /** Accumulate one completed turn's cost into the per-chat stats. */
  recordTurn(chatId: string, costUsd: number): void {
    this.db
      .prepare(
        `INSERT INTO chat_stats (chat_id, turns, cost_usd) VALUES (?, 1, ?)
         ON CONFLICT(chat_id) DO UPDATE SET turns = turns + 1, cost_usd = cost_usd + excluded.cost_usd`,
      )
      .run(chatId, costUsd)
  }

  /** Per-chat rolling stats. Returns zeros for a chat with no turns yet. */
  chatStats(chatId: string): { turns: number; costUsd: number; messages: number } {
    const s = this.db
      .prepare('SELECT turns, cost_usd FROM chat_stats WHERE chat_id = ?')
      .get(chatId) as { turns: number; cost_usd: number } | undefined
    const m = this.db
      .prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ?')
      .get(chatId) as { n: number }
    return { turns: s?.turns ?? 0, costUsd: s?.cost_usd ?? 0, messages: m.n }
  }

  /** Delete a chat's conversation history (used by /new). Returns rows removed. */
  clearHistory(chatId: string): number {
    return this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId).changes
  }

  /** Atomically claim an event_id. Returns true if this is a fresh event. */
  claimEvent(eventId: string, now = Date.now()): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO seen_events (event_id, seen_at) VALUES (?, ?)')
      .run(eventId, now)
    return r.changes > 0
  }

  /** Remove dedup entries older than `maxAgeMs` (default 7 days). */
  pruneSeenEvents(maxAgeMs = 7 * 24 * 3600 * 1000, now = Date.now()): number {
    const cutoff = now - maxAgeMs
    return this.db
      .prepare('DELETE FROM seen_events WHERE seen_at < ?')
      .run(cutoff).changes
  }

  appendMessage(
    chatId: string,
    role: 'user' | 'assistant',
    content: string,
    now = Date.now(),
  ): void {
    this.db
      .prepare('INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(chatId, role, content, now)
  }

  /** Return the most recent `limit` messages for a chat, oldest-first. */
  history(chatId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
      .all(chatId, limit) as StoredMessage[]
    return rows.reverse()
  }

  close(): void {
    this.db.close()
  }
}
