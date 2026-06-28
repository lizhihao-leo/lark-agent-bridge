import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

/**
 * Send an interactive card as a reply to a Feishu message, and PATCH the
 * card content in place as the agent makes progress.
 *
 * Send: `lark-cli im +messages-reply --content '<card-json>' --msg-type interactive`
 * Patch: `lark-cli api PATCH /open-apis/im/v1/messages/<id> --data '{"content": "<card-json>"}'`
 *
 * Both calls run as `bot` (only bots can reasonably patch their own
 * messages without scope friction). Failures are logged but never thrown.
 */

export interface CardSendResult {
  ok: boolean
  /** message_id of the freshly-sent card, if the send succeeded. */
  messageId?: string
}

export function sendCardReply(
  messageId: string,
  card: Record<string, unknown>,
): Promise<CardSendResult> {
  const content = JSON.stringify(card)
  const argv = [
    'im',
    '+messages-reply',
    '--as',
    'bot',
    '--message-id',
    messageId,
    '--content',
    content,
    '--msg-type',
    'interactive',
    '--format',
    'json',
  ]
  return new Promise((resolve) => {
    const child = spawn('lark-cli', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('exit', (code) => {
      if (code !== 0) {
        logger.error(
          { code, messageId, stderr: stderr.slice(0, 500) },
          'sendCardReply failed',
        )
        resolve({ ok: false })
        return
      }
      try {
        const obj = JSON.parse(stdout) as { data?: { message_id?: string } }
        const id = obj.data?.message_id
        if (id && id.startsWith('om_')) {
          logger.debug({ replyMessageId: id }, 'sendCardReply ok')
          resolve({ ok: true, messageId: id })
          return
        }
      } catch {
        // fall through
      }
      logger.warn({ stdout: stdout.slice(0, 300) }, 'sendCardReply: missing message_id')
      resolve({ ok: true })
    })
    child.on('error', (err) => {
      logger.error({ err: err.message }, 'spawn lark-cli (sendCardReply) failed')
      resolve({ ok: false })
    })
  })
}

/**
 * PATCH a previously-sent interactive card with new content. Feishu
 * accepts the new content body in-place; the user sees the card visibly
 * update without a new message being sent.
 */
export function patchCard(
  cardMessageId: string,
  card: Record<string, unknown>,
): Promise<boolean> {
  const body = JSON.stringify({ content: JSON.stringify(card) })
  const argv = [
    'api',
    'PATCH',
    `/open-apis/im/v1/messages/${cardMessageId}`,
    '--as',
    'bot',
    '--data',
    body,
    '--format',
    'json',
  ]
  return new Promise((resolve) => {
    const child = spawn('lark-cli', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(
          { code, cardMessageId, stderr: stderr.slice(0, 300) },
          'patchCard failed (best-effort)',
        )
        resolve(false)
        return
      }
      try {
        const obj = JSON.parse(stdout) as { ok?: boolean; error?: unknown }
        if (obj.ok === false) {
          logger.warn({ cardMessageId, error: obj.error }, 'patchCard returned ok:false')
          resolve(false)
          return
        }
      } catch {
        // fall through
      }
      resolve(true)
    })
    child.on('error', (err) => {
      logger.warn({ err: err.message }, 'spawn lark-cli (patchCard) failed')
      resolve(false)
    })
  })
}

/**
 * Debouncing throttle for `patchCard` — `CardPatcher` collects updates
 * from many fast-firing stream events and emits at most one PATCH every
 * `minIntervalMs`, while also guaranteeing the *final* state is flushed.
 *
 * Use:
 *   const p = new CardPatcher(cardMsgId)
 *   p.queue(card1)   // probably skipped
 *   p.queue(card2)   // probably skipped
 *   p.queue(card3)   // patched (≥ 1.2 s since last)
 *   await p.flush(finalCard)  // patched immediately
 */
export class CardPatcher {
  private latest: Record<string, unknown> | null = null
  private inFlight = false
  private lastSentAt = 0
  private scheduled: NodeJS.Timeout | null = null

  constructor(
    private readonly cardMessageId: string,
    private readonly minIntervalMs = 1200,
  ) {}

  /** Stage a new card snapshot. May be PATCHed, may be coalesced. */
  queue(card: Record<string, unknown>): void {
    this.latest = card
    this.maybeFire()
  }

  /** PATCH the given card *now* (bypasses the throttle); used for terminal states. */
  async flush(card: Record<string, unknown>): Promise<void> {
    this.latest = card
    if (this.scheduled) {
      clearTimeout(this.scheduled)
      this.scheduled = null
    }
    // Wait for any in-flight PATCH so we don't race.
    while (this.inFlight) await new Promise((r) => setTimeout(r, 50))
    await this.send()
  }

  private maybeFire(): void {
    if (this.scheduled) return
    const elapsed = Date.now() - this.lastSentAt
    if (this.inFlight || elapsed < this.minIntervalMs) {
      const delay = Math.max(50, this.minIntervalMs - elapsed)
      this.scheduled = setTimeout(() => {
        this.scheduled = null
        void this.send()
      }, delay)
      this.scheduled.unref?.()
      return
    }
    void this.send()
  }

  private async send(): Promise<void> {
    if (!this.latest) return
    const snapshot = this.latest
    this.latest = null
    this.inFlight = true
    try {
      await patchCard(this.cardMessageId, snapshot)
      this.lastSentAt = Date.now()
    } finally {
      this.inFlight = false
    }
    // A queued update may have arrived during the in-flight send; fire again.
    if (this.latest) this.maybeFire()
  }
}
