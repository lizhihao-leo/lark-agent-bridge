import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

/**
 * Add an emoji reaction to a Feishu message — used as an "ack" so the user
 * sees the bot has seen their message within ~200 ms, before the much
 * longer LLM round-trip starts.
 *
 * `emojiType` is Feishu's enum string (e.g. `OK`, `THUMBSUP`, `HEART`). See
 * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce
 *
 * Best-effort: failures are logged but never thrown.
 */
export function react(messageId: string, emojiType: string, as: 'bot' | 'user' = 'bot'): Promise<void> {
  const data = JSON.stringify({ reaction_type: { emoji_type: emojiType } })
  return new Promise((resolve) => {
    const child = spawn(
      'lark-cli',
      [
        'im',
        'reactions',
        'create',
        '--as',
        as,
        '--message-id',
        messageId,
        '--data',
        data,
        '--format',
        'json',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('exit', (code) => {
      if (code === 0) {
        logger.debug({ messageId, emojiType }, 'reaction ok')
      } else {
        logger.warn(
          { code, messageId, emojiType, stderr: stderr.slice(0, 300) },
          'reaction failed (best-effort)',
        )
      }
      resolve()
    })
    child.on('error', (err) => {
      logger.warn({ err: err.message }, 'spawn lark-cli (reactions) failed')
      resolve()
    })
  })
}
