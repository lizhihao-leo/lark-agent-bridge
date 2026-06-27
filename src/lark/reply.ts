import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

export interface ReplyOptions {
  messageId: string
  text: string
  as?: 'bot' | 'user'
}

/**
 * Send a reply to a Feishu message via `lark-cli im +messages-reply --text ...`.
 * Resolves regardless of outcome; failures are logged but do not throw —
 * callers are typically inside an event handler where a thrown reply
 * shouldn't break the consumer loop.
 */
export function replyText(opts: ReplyOptions): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      'lark-cli',
      [
        'im',
        '+messages-reply',
        '--as',
        opts.as ?? 'bot',
        '--message-id',
        opts.messageId,
        '--text',
        opts.text,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    child.on('exit', (code) => {
      if (code === 0) {
        logger.debug({ messageId: opts.messageId }, 'reply ok')
      } else {
        logger.error(
          { code, messageId: opts.messageId, stderr: stderr.slice(0, 500) },
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
