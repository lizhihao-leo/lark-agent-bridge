import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { logger } from '../logger.js'
import { isFeishuMessageEvent, type FeishuMessageEvent } from './types.js'

export interface ConsumeOptions {
  eventKey: string
  as: 'bot' | 'user' | 'auto'
  onEvent: (evt: FeishuMessageEvent) => void
}

/**
 * Spawn `lark-cli event consume` and stream parsed events to `onEvent`.
 *
 * Critical detail: stdin must remain an open pipe. lark-cli treats stdin EOF
 * as a graceful-shutdown signal in unbounded mode, so `stdio: 'ignore'` would
 * kill the consumer with `context canceled` within seconds.
 *
 * Returned handle exposes the child process so callers can SIGTERM it cleanly.
 */
export function startConsumer(opts: ConsumeOptions): {
  child: ChildProcessWithoutNullStreams
  stop: () => void
} {
  const child = spawn(
    'lark-cli',
    ['event', 'consume', opts.eventKey, '--as', opts.as, '--quiet'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )

  child.stderr.on('data', (buf) => {
    // lark-cli prints status lines to stderr; surface them at debug level.
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.trim()) logger.debug({ src: 'lark-cli' }, line)
    }
  })

  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      logger.warn({ line: line.slice(0, 200) }, 'non-JSON line from lark-cli')
      return
    }
    if (!isFeishuMessageEvent(parsed)) {
      logger.debug({ parsed }, 'ignoring non-message event')
      return
    }
    try {
      opts.onEvent(parsed)
    } catch (err) {
      logger.error({ err }, 'onEvent handler threw')
    }
  })

  const stop = () => {
    if (!child.killed) child.kill('SIGTERM')
  }

  return { child, stop }
}
