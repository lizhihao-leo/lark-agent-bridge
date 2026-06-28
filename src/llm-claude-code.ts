import { spawn } from 'node:child_process'
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
 *   - We use `--output-format json` (single JSON object after completion).
 *   - The reply text is the `result` field; we surface stop_reason / cost /
 *     duration in our logs for observability.
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
  // Claude Code requires --session-id to look like a UUID
  // (8-4-4-4-12 hex with the version/variant nibbles in the right place).
  // We derive a deterministic UUIDv4 from a sha256 of the chat_id so that
  // even if the session map is wiped, the id stays stable for that chat.
  const h = createHash('sha256').update(`lark-agent-bridge:${chatId}`).digest('hex')
  // Force version=4 in nibble 12 and variant=8/9/a/b in nibble 16.
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

export interface ClaudeCodeResult {
  text: string
  sessionId: string
  /** Claude Code's reported total cost in USD (if available). */
  costUsd: number | undefined
  /** Wall-clock seconds spent inside the subprocess. */
  durationSec: number
  /** stop_reason from the json output, if any. */
  stopReason: string | undefined
}

/**
 * Run a one-shot `claude -p` for this chat, resuming the session if known.
 */
export function runClaudeCode(chatId: string, userText: string): Promise<ClaudeCodeResult> {
  const sessions = loadSessions()
  let sessionId = sessions[chatId]
  let isFirstTurn = !sessionId
  if (!sessionId) {
    sessionId = deriveSessionId(chatId)
    sessions[chatId] = sessionId
    saveSessions(sessions)
  }

  return runOnce(chatId, userText, sessionId, isFirstTurn).then(async (result) => {
    // If we tried --session-id but Claude Code says "already in use",
    // it means the session exists server-side (e.g. our local map was
    // wiped). Fall back to --resume transparently.
    if (
      isFirstTurn &&
      result.stopReason === 'error' &&
      /already in use/i.test(result.text)
    ) {
      logger.info({ chatId }, 'session existed server-side, retrying with --resume')
      isFirstTurn = false
      return runOnce(chatId, userText, sessionId, false)
    }
    return result
  })
}

function runOnce(
  chatId: string,
  userText: string,
  sessionId: string,
  isFirstTurn: boolean,
): Promise<ClaudeCodeResult> {
  const argv: string[] = [
    '-p',
    '--bare',
    '--dangerously-skip-permissions',
    '--output-format',
    'json',
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
        // Make sure pino-pretty doesn't leak into the subprocess stdout.
        FORCE_COLOR: '0',
      },
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    const killer = setTimeout(() => {
      logger.warn({ chatId, sec: config.CLAUDE_CODE_TIMEOUT_SEC }, 'claude-code timed out')
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, config.CLAUDE_CODE_TIMEOUT_SEC * 1000)

    child.on('exit', (code) => {
      clearTimeout(killer)
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
        })
        return
      }

      // Parse the JSON output. Claude Code prints exactly one JSON object on
      // stdout when --output-format=json is used.
      try {
        const obj = JSON.parse(stdout) as {
          result?: string
          session_id?: string
          stop_reason?: string
          total_cost_usd?: number
          is_error?: boolean
          subtype?: string
        }
        if (obj.is_error) {
          logger.warn({ obj, chatId }, 'claude-code reported is_error')
        }
        // Claude Code may rename our session — adopt whatever it returns
        // so the next --resume works.
        let effectiveSession = sessionId
        if (obj.session_id && obj.session_id !== sessionId) {
          const sessions = loadSessions()
          sessions[chatId] = obj.session_id
          saveSessions(sessions)
          effectiveSession = obj.session_id
        }
        resolve({
          text: (obj.result ?? '').trim() || '(Claude Code 没有返回文本)',
          sessionId: effectiveSession,
          costUsd: obj.total_cost_usd,
          durationSec,
          stopReason: obj.stop_reason,
        })
      } catch (err) {
        logger.error(
          { err, head: stdout.slice(0, 400), chatId },
          'failed to parse claude-code json output',
        )
        resolve({
          text: stdout.slice(0, 1500).trim() || '(Claude Code 无输出)',
          sessionId,
          costUsd: undefined,
          durationSec,
          stopReason: 'unparseable',
        })
      }
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
      })
    })
  })
}
