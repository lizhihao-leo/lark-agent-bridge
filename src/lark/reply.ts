import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

export interface ReplyOptions {
  messageId: string
  /** Plain text (use `format: 'text'`) or markdown (use `format: 'markdown'`). */
  body: string
  format?: 'text' | 'markdown'
  as?: 'bot' | 'user'
}

export interface ReplyResult {
  ok: boolean
  /** The message_id (om_...) of the freshly-sent reply, if the API returned one. */
  replyMessageId?: string
}

/**
 * Reply to a Feishu message via `lark-cli im +messages-reply`.
 *
 * Returns the new message's `om_*` id when the API succeeds — needed when the
 * caller wants to delete or visually mark the message later (e.g. removing a
 * "thinking…" placeholder).
 *
 * Failures are logged but never thrown — the consumer loop should keep
 * running even if one reply API call goes wrong.
 */
export function reply(opts: ReplyOptions): Promise<ReplyResult> {
  const format = opts.format ?? 'text'
  const args = [
    'im',
    '+messages-reply',
    '--as',
    opts.as ?? 'bot',
    '--message-id',
    opts.messageId,
    format === 'markdown' ? '--markdown' : '--text',
    opts.body,
    '--format',
    'json',
  ]

  return new Promise((resolve) => {
    const child = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    child.on('exit', (code) => {
      if (code === 0) {
        const id = extractReplyMessageId(stdout)
        logger.debug({ messageId: opts.messageId, format, replyMessageId: id }, 'reply ok')
        resolve(id ? { ok: true, replyMessageId: id } : { ok: true })
      } else {
        logger.error(
          { code, format, messageId: opts.messageId, stderr: stderr.slice(0, 500) },
          'reply failed',
        )
        resolve({ ok: false })
      }
    })

    child.on('error', (err) => {
      logger.error({ err: err.message }, 'spawn lark-cli failed')
      resolve({ ok: false })
    })
  })
}

/** Best-effort extraction of `message_id` from lark-cli JSON output. */
function extractReplyMessageId(stdout: string): string | undefined {
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>
    const data = (obj['data'] ?? obj) as Record<string, unknown>
    const id = data['message_id']
    if (typeof id === 'string' && id.startsWith('om_')) return id
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Recall (delete) a previously-sent message. Best-effort — failures are
 * logged but never thrown; the caller's flow should not depend on success.
 */
export function recall(messageId: string, as: 'bot' | 'user' = 'bot'): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      'lark-cli',
      ['im', 'messages', 'delete', '--as', as, '--params', JSON.stringify({ message_id: messageId }), '--yes'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('exit', (code) => {
      if (code === 0) {
        logger.debug({ messageId }, 'recall ok')
      } else {
        logger.warn(
          { code, messageId, stderr: stderr.slice(0, 300) },
          'recall failed (this is best-effort)',
        )
      }
      resolve()
    })
    child.on('error', (err) => {
      logger.warn({ err: err.message }, 'spawn lark-cli (recall) failed')
      resolve()
    })
  })
}

/** Convenience wrapper for backwards-compat with Phase 0/1 code. */
export function replyText(opts: {
  messageId: string
  text: string
  as?: 'bot' | 'user'
}): Promise<ReplyResult> {
  return reply({
    messageId: opts.messageId,
    body: opts.text,
    format: 'text',
    ...(opts.as ? { as: opts.as } : {}),
  })
}
