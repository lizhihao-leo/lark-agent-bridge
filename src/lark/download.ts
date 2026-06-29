import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

/**
 * Download an image / file resource referenced by a Feishu message into a
 * cwd-relative path via `lark-cli im +messages-resources-download`. The
 * CLI handles auth + the streaming binary fetch; we just point it at the
 * right `message_id` + `file_key`.
 *
 * Returns `{ ok: true, output }` where `output` is the path lark-cli
 * actually wrote to (lark-cli may auto-extension the file based on
 * Content-Type when our suggested name lacks one).
 */

export interface DownloadResult {
  ok: boolean
  /** cwd-relative output path actually written, if known. */
  output?: string
}

export function downloadResource(opts: {
  messageId: string
  fileKey: string
  /** `image` | `file`. `image` requires a `img_…` key. */
  type: 'image' | 'file'
  /** cwd-relative; lark-cli rejects absolute paths and `..`. */
  output: string
  /** Working directory for the lark-cli child — defines the cwd root. */
  cwd: string
  as?: 'bot' | 'user'
}): Promise<DownloadResult> {
  const argv = [
    'im',
    '+messages-resources-download',
    '--as',
    opts.as ?? 'bot',
    '--message-id',
    opts.messageId,
    '--file-key',
    opts.fileKey,
    '--type',
    opts.type,
    '--output',
    opts.output,
    '--format',
    'json',
  ]
  return new Promise((resolve) => {
    const child = spawn('lark-cli', argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('exit', (code) => {
      if (code !== 0) {
        logger.error(
          {
            code,
            messageId: opts.messageId,
            fileKey: opts.fileKey,
            stderr: stderr.slice(0, 500),
          },
          'downloadResource failed',
        )
        resolve({ ok: false })
        return
      }
      let output: string | undefined
      try {
        const obj = JSON.parse(stdout) as {
          data?: { saved_path?: string; output?: string; path?: string }
        }
        output = obj.data?.saved_path ?? obj.data?.output ?? obj.data?.path ?? opts.output
      } catch {
        output = opts.output
      }
      logger.debug({ messageId: opts.messageId, output }, 'downloadResource ok')
      resolve({ ok: true, ...(output ? { output } : {}) })
    })
    child.on('error', (err) => {
      logger.error({ err: err.message }, 'spawn lark-cli (download) failed')
      resolve({ ok: false })
    })
  })
}
