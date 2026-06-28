import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { logger } from '../logger.js'

/**
 * Consume `card.action.trigger` events — fired when a user clicks a
 * button or interacts with any other component on an interactive card
 * the bot has sent.
 *
 * Note: this requires the app's Feishu Developer Console to have
 * "Callback Configuration" enabled (应用 → 事件与回调 → 回调配置). The
 * consumer subprocess starts without errors when it's not enabled; it
 * simply receives no events.
 *
 * Event shape (lark-cli normalises it to flat root fields, just like
 * `im.message.receive_v1`):
 *   {
 *     type: 'card.action.trigger',
 *     event_id, message_id, chat_id, operator_id, host,
 *     action_tag,                     // 'button', 'select_static', ...
 *     action_value,                   // JSON-string of the component's `value`
 *     action_name?,
 *     ...
 *   }
 */

export interface CardActionEvent {
  chatId: string
  messageId: string
  operatorId: string
  /** Parsed object from `action_value`, or `{}` if absent / unparseable. */
  actionValue: Record<string, unknown>
  actionTag: string
}

export interface CardActionConsumerHandle {
  stop: () => Promise<void>
}

export function startCardActionConsumer(
  onAction: (a: CardActionEvent) => void | Promise<void>,
): CardActionConsumerHandle {
  let stopping = false
  let current: ChildProcessWithoutNullStreams | null = null

  function spawnOnce(): void {
    if (stopping) return
    const child = spawn(
      'lark-cli',
      ['event', 'consume', 'card.action.trigger', '--as', 'bot', '--quiet'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    current = child
    logger.info({ pid: child.pid }, 'card.action.trigger consumer spawned')

    child.stderr.on('data', (buf) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.trim()) logger.debug({ src: 'lark-cli-card' }, line)
      }
    })

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        logger.warn({ line: line.slice(0, 200) }, 'non-JSON card.action line')
        return
      }
      if (parsed['type'] !== 'card.action.trigger') {
        logger.debug({ type: parsed['type'] }, 'ignoring non-card-action event')
        return
      }
      const messageId = typeof parsed['message_id'] === 'string' ? parsed['message_id'] : ''
      const chatId = typeof parsed['chat_id'] === 'string' ? parsed['chat_id'] : ''
      const operatorId = typeof parsed['operator_id'] === 'string' ? parsed['operator_id'] : ''
      const actionTag = typeof parsed['action_tag'] === 'string' ? parsed['action_tag'] : ''
      if (!messageId || !chatId) {
        logger.warn({ parsed }, 'card.action.trigger missing message_id or chat_id')
        return
      }
      let actionValue: Record<string, unknown> = {}
      const rawVal = parsed['action_value']
      if (typeof rawVal === 'string' && rawVal.trim()) {
        try {
          const v = JSON.parse(rawVal) as unknown
          if (v && typeof v === 'object') actionValue = v as Record<string, unknown>
        } catch {
          // Could be a bare string; expose under `_raw`.
          actionValue = { _raw: rawVal }
        }
      } else if (rawVal && typeof rawVal === 'object') {
        actionValue = rawVal as Record<string, unknown>
      }

      try {
        const ret = onAction({ chatId, messageId, operatorId, actionValue, actionTag })
        if (ret instanceof Promise) {
          ret.catch((err) => logger.error({ err }, 'onAction threw (async)'))
        }
      } catch (err) {
        logger.error({ err }, 'onAction threw')
      }
    })

    child.on('exit', (code, signal) => {
      current = null
      logger.warn({ code, signal, stopping }, 'card.action.trigger consumer exited')
      if (stopping) return
      setTimeout(spawnOnce, 2000).unref()
    })
  }

  spawnOnce()

  async function stop(): Promise<void> {
    stopping = true
    if (current) {
      const c = current
      c.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (!c.killed) c.kill('SIGKILL')
          resolve()
        }, 5000)
        c.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  return { stop }
}
