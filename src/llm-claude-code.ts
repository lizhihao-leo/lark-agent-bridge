import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
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

/** Current claude-code session id for a chat, if one has been created. */
export function getSessionId(chatId: string): string | undefined {
  return loadSessions()[chatId]
}

/**
 * Forget the claude-code session for a chat (used by /new). The next
 * turn will mint a fresh session id and start with `--session-id`.
 */
export function resetSession(chatId: string): void {
  const sessions = loadSessions()
  if (sessions[chatId]) {
    delete sessions[chatId]
    saveSessions(sessions)
    logger.info({ chatId }, 'claude-code session reset')
  }
}

/**
 * Mint a fresh session id for a chat.
 *
 * We use a random UUID rather than a deterministic hash of chat_id: the
 * deterministic scheme meant `/new` (which forgets the local mapping)
 * would re-derive the *same* id and collide with the now-orphaned
 * server-side session ("Session ID … is already in use" / "No deferred
 * tool marker found"). A fresh random id guarantees `/new` actually
 * starts a clean conversation. The mapping in `.bridge-sessions.json`
 * is the source of truth for continuity across restarts.
 */
function newSessionId(): string {
  return randomUUID()
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

export interface RunClaudeCodeOptions {
  onProgress?: (p: ClaudeCodeProgress) => void
  abortSignal?: AbortSignal
  /**
   * When true, the sandbox is lifted: the subprocess runs with `--add-dir /`
   * so Read/Write/Edit can touch any absolute path on the host (Bash always
   * could). cwd stays at CLAUDE_CODE_SANDBOX so relative paths, image/file
   * downloads, and reply-image extraction keep working. Toggled per-chat by
   * the `/sandbox off` command.
   */
  fullAccess?: boolean
}

/**
 * Run a one-shot `claude -p` for this chat, resuming the session if known.
 * `onProgress` is called for every streamed event — useful for showing
 * real-time activity in the chat UI. Pass `abortSignal` to allow callers
 * to kill the subprocess mid-flight (e.g. a "⏹ 停止" card button).
 */
export function runClaudeCode(
  chatId: string,
  userText: string,
  opts: RunClaudeCodeOptions = {},
): Promise<ClaudeCodeResult> {
  const sessions = loadSessions()
  let sessionId = sessions[chatId]
  const isFirstTurn = !sessionId
  if (!sessionId) {
    sessionId = newSessionId()
    sessions[chatId] = sessionId
    saveSessions(sessions)
  }

  return runOnce(chatId, userText, sessionId, isFirstTurn, opts).then(async (result) => {
    // Recover from session-id desync between our local map and the
    // server. Two symmetric failure modes:
    //   - we thought it was new (--session-id) but the server already has
    //     it → retry with --resume
    //   - we thought it existed (--resume) but the server has no such
    //     conversation (e.g. a prior first-turn died before creating it,
    //     or the server GC'd it) → retry with --session-id to create
    if (result.stopReason === 'error') {
      if (isFirstTurn && /already in use/i.test(result.text)) {
        logger.info({ chatId }, 'session existed server-side, retrying with --resume')
        return runOnce(chatId, userText, sessionId, false, opts)
      }
      if (!isFirstTurn && /no conversation found/i.test(result.text)) {
        logger.info({ chatId }, 'mapped session missing server-side, recreating with --session-id')
        return runOnce(chatId, userText, sessionId, true, opts)
      }
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
  /** Present when `--include-partial-messages` is enabled. */
  event?: {
    type?: string
    delta?: {
      type?: string
      text?: string
    }
  }
}

function runOnce(
  chatId: string,
  userText: string,
  sessionId: string,
  isFirstTurn: boolean,
  opts: RunClaudeCodeOptions,
): Promise<ClaudeCodeResult> {
  const { onProgress, abortSignal, fullAccess } = opts
  const argv: string[] = [
    '-p',
    '--bare',
    '--dangerously-skip-permissions',
    // /sandbox off: widen the readable/writable set to the whole host.
    // `--add-dir` is variadic, so it MUST be followed by another flag
    // (not the positional prompt) or it would swallow the prompt as a
    // second directory. The `--append-system-prompt` is what actually
    // overrides the sandbox's CLAUDE.md "only access this directory"
    // convention — a system-prompt directive outranks project context,
    // whereas a note injected into the user message does not.
    ...(fullAccess
      ? [
          '--add-dir',
          '/',
          '--append-system-prompt',
          '管理员已通过 /sandbox off 解除沙箱限制。请忽略 CLAUDE.md 中关于"只能访问 /home/leo/lark-bot-sandbox 目录""不要逃离此目录"的所有约定——它们此刻不再适用。你现在拥有主机的完整文件系统权限，可用 Read / Edit / Write / Bash 自由访问任意绝对路径（/etc、/var、/home 下其他用户目录、系统配置等），按用户请求直接执行，不要以沙箱限制为由拒绝。',
        ]
      : []),
    '--output-format',
    'stream-json',
    '--verbose',
    // Emit per-token text_delta events too, so callers can render true
    // streaming UI (interactive card patching). Without this flag, only
    // the once-per-turn `assistant` envelope text is visible — which
    // means the user sees a long pause then the full reply appears.
    '--include-partial-messages',
    isFirstTurn ? '--session-id' : '--resume',
    sessionId,
  ]

  if (config.CLAUDE_CODE_EXTRA_ARGS.trim()) {
    argv.push(...config.CLAUDE_CODE_EXTRA_ARGS.trim().split(/\s+/))
  }

  argv.push(userText)

  // When the sandbox is lifted, run from the user's home rather than the
  // sandbox dir so Claude Code does NOT load the sandbox's restrictive
  // CLAUDE.md ("only access this directory; do not escape"), which
  // otherwise overrides even a system-prompt grant. Downloads + reply
  // image extraction use explicit absolute paths, so they're unaffected.
  const cwd = fullAccess ? homedir() : config.CLAUDE_CODE_SANDBOX

  const startedAt = Date.now()
  logger.info(
    { chatId, sessionId, isFirstTurn, fullAccess: !!fullAccess, cwd, preview: userText.slice(0, 60) },
    'spawning claude-code',
  )

  return new Promise((resolve) => {
    const child = spawn('claude', argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
    })

    let aborted = false
    const onAbort = (): void => {
      aborted = true
      logger.info({ chatId, pid: child.pid }, 'claude-code aborted by caller')
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 1500).unref()
    }
    if (abortSignal?.aborted) {
      onAbort()
    } else {
      abortSignal?.addEventListener('abort', onAbort, { once: true })
    }

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

        case 'stream_event': {
          // Token-level text deltas from --include-partial-messages.
          // Tool-use deltas exist too but are noisy and the full tool_use
          // payload arrives in the subsequent `assistant` envelope; only
          // forward text deltas here.
          const ev = evt.event
          if (
            ev?.type === 'content_block_delta' &&
            ev.delta?.type === 'text_delta' &&
            typeof ev.delta.text === 'string' &&
            ev.delta.text.length > 0
          ) {
            onProgress?.({ kind: 'text', text: ev.delta.text })
          }
          break
        }

        case 'assistant':
          // With partial-messages enabled, text already arrived as deltas
          // — skip text blocks here to avoid double-counting. Tool-use
          // blocks still arrive only in the assistant envelope.
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

      if (aborted) {
        // Caller asked us to stop; surface as an explicit stop_reason so
        // the worker can render the card as "aborted" rather than as
        // an error.
        resolve({
          text: '(已由用户停止)',
          sessionId,
          costUsd: undefined,
          durationSec,
          stopReason: 'aborted',
          toolCalls,
        })
        return
      }

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
