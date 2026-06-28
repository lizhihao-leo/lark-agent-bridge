import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { config } from './config.js'
import { logger } from './logger.js'

/**
 * Claude Code backend: spawns a headless `claude -p` subprocess per message,
 * resuming the per-chat session so context is preserved.
 *
 * Session ID strategy:
 *   - One Claude Code session per Feishu chat_id.
 *   - We persist `chat_id -> session_id` mapping in a tiny JSON file inside
 *     the sandbox (not in SQLite — it's a separate concern, and the sandbox
 *     dir is the natural place since that's where claude-code's transcripts
 *     live too).
 *   - The first time we see a chat_id, we generate a fresh UUID-like session
 *     and let Claude Code create the session on first run.
 *
 * Output parsing:
 *   - We use `--output-format stream-json --verbose`, which emits one JSON
 *     event per line:
 *       * `system/init`   — startup; tools/cwd/model declared
 *       * `assistant`     — model output (may be tool_use or text blocks)
 *       * `user`          — tool_result blocks (synthesised, not real user)
 *       * `result`        — the final wrap-up with `result.result` = final text
 *     We forward each event to an optional onProgress callback so the caller
 *     can show "🛠 running Bash…" in the chat UI in real time. The final
 *     ClaudeCodeResult is derived from the `result` envelope.
 */

interface SessionMap {
  [chatId: string]: string
}

const SESSION_FILE = join(config.CLAUDE_CODE_SANDBOX, '.bridge-sessions.json')

function loadSessions(): SessionMap {
  try {
    if (!existsSync(SESSION_FILE)) return {}
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as SessionMap
  } catch (err) {
    logger.warn({ err }, 'failed to read session map, starting empty')
    return {}
  }
}

function saveSessions(map: SessionMap): void {
  try {
    mkdirSync(config.CLAUDE_CODE_SANDBOX, { recursive: true })
    writeFileSync(SESSION_FILE, JSON.stringify(map, null, 2))
  } catch (err) {
    logger.error({ err }, 'failed to persist session map')
  }
}

/** Deterministic UUIDv4-shaped session id from chat_id. */
function deriveSessionId(chatId: string): string {
  const h = createHash('sha256').update(`lark-agent-bridge:${chatId}`).digest('hex')
  const v4 =
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-' +
    '4' +
    h.slice(13, 16) +
    '-' +
    ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) +
    h.slice(17, 20) +
    '-' +
    h.slice(20, 32)
  return v4
}

/** Streaming progress events extracted from `--output-format stream-json`. */
export type ClaudeCodeProgress =
  | { kind: 'tool_use'; tool: string; brief: string; toolUseId: string }
  | { kind: 'tool_result'; toolUseId: string; tool: string; ok: boolean; preview: string }
  | { kind: 'text'; text: string }

export interface ClaudeCodeResult {
  text: string
  sessionId: string
  /** Claude Code's reported total cost in USD (if available). */
  costUsd: number | undefined
  /** Wall-clock seconds spent inside the subprocess. */
  durationSec: number
  /** stop_reason from the json output, if any. */
  stopReason: string | undefined
  /** Number of tool_use blocks the model emitted. */
  toolCalls: number
}

/**
 * Run a one-shot `claude -p` for this chat, resuming the session if known.
 * `onProgress` is called for every streamed event — useful for showing
 * real-time activity in the chat UI.
 */
export function runClaudeCode(
  chatId: string,
  userText: string,
  onProgress?: (p: ClaudeCodeProgress) => void,
): Promise<ClaudeCodeResult> {
  const sessions = loadSessions()
  let sessionId = sessions[chatId]
  let isFirstTurn = !sessionId
  if (!sessionId) {
    sessionId = deriveSessionId(chatId)
    sessions[chatId] = sessionId
    saveSessions(sessions)
  }

  return runOnce(chatId, userText, sessionId, isFirstTurn, onProgress).then(async (result) => {
    if (
      isFirstTurn &&
      result.stopReason === 'error' &&
      /already in use/i.test(result.text)
    ) {
      logger.info({ chatId }, 'session existed server-side, retrying with --resume')
      isFirstTurn = false
      return runOnce(chatId, userText, sessionId, false, onProgress)
    }
    return result
  })
}

interface StreamEvent {
  type?: string
  subtype?: string
  result?: string
  session_id?: string
  stop_reason?: string
  total_cost_usd?: number
  is_error?: boolean
  message?: {
    content?: Array<{
      type: string
      text?: string
      name?: string
      id?: string
      input?: Record<string, unknown>
      tool_use_id?: string
      content?: string | Array<{ type: string; text?: string }>
    }>
  }
}

function runOnce(
  chatId: string,
  userText: string,
  sessionId: string,
  isFirstTurn: boolean,
  onProgress?: (p: ClaudeCodeProgress) => void,
): Promise<ClaudeCodeResult> {
  const argv: string[] = [
    '-p',
    '--bare',
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
    isFirstTurn ? '--session-id' : '--resume',
    sessionId,
  ]

  if (config.CLAUDE_CODE_EXTRA_ARGS.trim()) {
    argv.push(...config.CLAUDE_CODE_EXTRA_ARGS.trim().split(/\s+/))
  }

  argv.push(userText)

  const startedAt = Date.now()
  logger.info(
    { chatId, sessionId, isFirstTurn, preview: userText.slice(0, 60) },
    'spawning claude-code',
  )

  return new Promise((resolve) => {
    const child = spawn('claude', argv, {
      cwd: config.CLAUDE_CODE_SANDBOX,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
    })

    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    // Parse stream-json line by line. We keep the last `result` event around
    // (it carries the final reply and cost) and forward intermediate events
    // to the progress callback.
    let finalEvent: StreamEvent | undefined
    let serverSessionId: string | undefined
    let toolCalls = 0
    const toolNameById = new Map<string, string>()

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let evt: StreamEvent
      try {
        evt = JSON.parse(line) as StreamEvent
      } catch {
        logger.debug({ chatId, line: line.slice(0, 200) }, 'unparseable stream-json line')
        return
      }

      switch (evt.type) {
        case 'system':
          if (evt.subtype === 'init' && evt.session_id) serverSessionId = evt.session_id
          break

        case 'assistant':
          for (const block of evt.message?.content ?? []) {
            if (block.type === 'tool_use' && block.name && block.id) {
              toolCalls++
              toolNameById.set(block.id, block.name)
              const brief = summariseToolInput(block.name, block.input ?? {})
              onProgress?.({
                kind: 'tool_use',
                tool: block.name,
                brief,
                toolUseId: block.id,
              })
            } else if (block.type === 'text' && block.text) {
              onProgress?.({ kind: 'text', text: block.text })
            }
          }
          break

        case 'user':
          for (const block of evt.message?.content ?? []) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const tool = toolNameById.get(block.tool_use_id) ?? 'tool'
              const preview = stringifyToolResult(block.content)
              onProgress?.({
                kind: 'tool_result',
                toolUseId: block.tool_use_id,
                tool,
                ok: !evt.is_error,
                preview: preview.slice(0, 200),
              })
            }
          }
          break

        case 'result':
          finalEvent = evt
          if (evt.session_id) serverSessionId = evt.session_id
          break
      }
    })

    const killer = setTimeout(() => {
      logger.warn({ chatId, sec: config.CLAUDE_CODE_TIMEOUT_SEC }, 'claude-code timed out')
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, config.CLAUDE_CODE_TIMEOUT_SEC * 1000)

    child.on('exit', (code) => {
      clearTimeout(killer)
      rl.close()
      const durationSec = (Date.now() - startedAt) / 1000

      if (code !== 0) {
        logger.error(
          { code, stderr: stderr.slice(0, 800), chatId, durationSec },
          'claude-code exited non-zero',
        )
        resolve({
          text: stderr.trim() || `(Claude Code 退出码 ${code}, 无 stderr)`,
          sessionId,
          costUsd: undefined,
          durationSec,
          stopReason: 'error',
          toolCalls,
        })
        return
      }

      // Persist the server-side session id (Claude Code occasionally renames).
      let effectiveSession = sessionId
      if (serverSessionId && serverSessionId !== sessionId) {
        const sessions = loadSessions()
        sessions[chatId] = serverSessionId
        saveSessions(sessions)
        effectiveSession = serverSessionId
      }

      if (!finalEvent) {
        logger.error({ chatId }, 'claude-code finished without a result event')
        resolve({
          text: '(Claude Code 没有返回 result 事件)',
          sessionId: effectiveSession,
          costUsd: undefined,
          durationSec,
          stopReason: 'no-result',
          toolCalls,
        })
        return
      }

      if (finalEvent.is_error) {
        logger.warn({ chatId, finalEvent }, 'claude-code reported is_error')
      }

      resolve({
        text: (finalEvent.result ?? '').trim() || '(Claude Code 没有返回文本)',
        sessionId: effectiveSession,
        costUsd: finalEvent.total_cost_usd,
        durationSec,
        stopReason: finalEvent.stop_reason,
        toolCalls,
      })
    })

    child.on('error', (err) => {
      clearTimeout(killer)
      logger.error({ err: err.message, chatId }, 'spawn claude failed')
      resolve({
        text: `(无法启动 Claude Code: ${err.message})`,
        sessionId,
        costUsd: undefined,
        durationSec: (Date.now() - startedAt) / 1000,
        stopReason: 'spawn-error',
        toolCalls: 0,
      })
    })
  })
}

/** One-line human summary of a tool_use input — for logs and (future) UI. */
function summariseToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return String(input['command'] ?? '').slice(0, 120)
    case 'Read':
    case 'Edit':
    case 'Write':
      return String(input['file_path'] ?? input['path'] ?? '').slice(0, 120)
    case 'Grep':
      return `${String(input['pattern'] ?? '').slice(0, 80)} in ${String(input['path'] ?? '.')}`
    case 'Glob':
      return String(input['pattern'] ?? '').slice(0, 120)
    default:
      return JSON.stringify(input).slice(0, 120)
  }
}

/** Compact a tool_result content payload (string or array of text blocks) to a string. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && 'text' in (b as Record<string, unknown>)
          ? String((b as { text: string }).text ?? '')
          : '',
      )
      .join('')
  }
  return ''
}
