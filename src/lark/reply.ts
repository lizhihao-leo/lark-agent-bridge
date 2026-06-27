import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

export interface ReplyOptions {
  messageId: string
  /** Plain text (use `format: 'text'`) or markdown (use `format: 'markdown'`). */
  body: string
  format?: 'text' | 'markdown'
  as?: 'bot' | 'user'
}

/**
 * Reply to a Feishu message via `lark-cli im +messages-reply`.
 *
 * Failures are logged but never thrown — the consumer loop should keep
 * running even if one reply API call goes wrong.
 */
export function reply(opts: ReplyOptions): Promise<void> {
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
  ]

  return new Promise((resolve) => {
    const child = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    child.on('exit', (code) => {
      if (code === 0) {
        logger.debug({ messageId: opts.messageId, format }, 'reply ok')
      } else {
        logger.error(
          { code, format, messageId: opts.messageId, stderr: stderr.slice(0, 500) },
          'reply failed',
        )
      }
      resolve()
    })

    child.on('error', (err) => {
      logger.error({ err: err.message }, 'spawn lark-cli failed')
      resolve()
    })
  })
}

/** Convenience wrapper for backwards-compat with Phase 0/1 code. */
export function replyText(opts: {
  messageId: string
  text: string
  as?: 'bot' | 'user'
}): Promise<void> {
  return reply({
    messageId: opts.messageId,
    body: opts.text,
    format: 'text',
    ...(opts.as ? { as: opts.as } : {}),
  })
}
