import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

export interface CliResult {
  ok: boolean
  /** Parsed JSON output if the command produced JSON; raw text otherwise. */
  data: unknown
  raw: string
  stderr: string
  exitCode: number
}

/**
 * Run `lark-cli` with the given argv, return its stdout JSON (or raw text on parse failure).
 *
 * - Always passes `--format json` unless `--format` / `--text` / etc. is already present.
 * - Captures stderr separately so tool-call results can include diagnostic info.
 * - Times out at `timeoutMs` (default 30s); a killed command resolves with ok=false.
 */
export function runCli(argv: string[], timeoutMs = 30_000): Promise<CliResult> {
  const wantsFormat = argv.some(
    (a) => a === '--format' || a === '--json' || a === '--text' || a === '--ndjson',
  )
  const finalArgv = wantsFormat ? argv : [...argv, '--format', 'json']

  return new Promise((resolve) => {
    const child = spawn('lark-cli', finalArgv, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    const killTimer = setTimeout(() => {
      logger.warn({ argv: finalArgv, timeoutMs }, 'lark-cli timed out, killing')
      child.kill('SIGTERM')
    }, timeoutMs)

    child.on('exit', (code) => {
      clearTimeout(killTimer)
      const exitCode = code ?? -1
      let data: unknown = null
      try {
        data = JSON.parse(stdout)
      } catch {
        data = stdout
      }
      resolve({
        ok: exitCode === 0,
        data,
        raw: stdout,
        stderr,
        exitCode,
      })
    })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      logger.error({ err: err.message }, 'spawn lark-cli failed')
      resolve({ ok: false, data: null, raw: '', stderr: err.message, exitCode: -1 })
    })
  })
}
