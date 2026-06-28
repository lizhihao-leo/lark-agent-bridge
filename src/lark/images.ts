import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Extract local image references (`![alt](path)`) from an LLM-produced
 * markdown body and return:
 *   - `images`: list of resolvable local files (cwd-relative paths suitable
 *     for `lark-cli im +messages-{reply,send} --image <path>`, which rejects
 *     absolute paths and `..`)
 *   - `stripped`: the body with each surfaced image reference replaced by a
 *     short `[图片: <alt>]` caption so the text reply still reads coherently
 *
 * URL refs (`http(s)://`) and image-key refs (`img_...`) are left untouched —
 * `lark-cli --markdown` auto-resolves image URLs, and bare image keys aren't
 * markdown anyway. Refs whose file is outside the sandbox, contains `..`, or
 * doesn't exist are also left untouched (with a `reason` in `skipped`) so the
 * user at least sees the original markdown rather than silent loss.
 */

export interface ExtractedImage {
  /** cwd-relative path, safe to pass to `lark-cli --image` with cwd=sandboxDir */
  relPath: string
  /** Resolved absolute path on disk (for logging / verification only) */
  absPath: string
  /** Alt text from the markdown ref (may be empty) */
  alt: string
  /** The original `![alt](path)` substring, useful for debugging */
  original: string
}

export interface SkippedImage {
  ref: string
  reason: 'escapes-sandbox' | 'not-found' | 'not-a-file' | 'unparseable'
}

export interface ImageExtraction {
  images: ExtractedImage[]
  skipped: SkippedImage[]
  /** Body with surfaced local-file refs replaced by `[图片: <alt>]` placeholders. */
  stripped: string
}

// Matches `![alt](path)` and `![alt](path "title")`. Path stops at the first
// whitespace or closing paren; we deliberately don't try to support paths with
// literal spaces (LLM-generated paths rarely have them, and CommonMark requires
// them to be wrapped in `<...>` which we'd also reject as not a real file).
const IMG_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

export function extractLocalImages(body: string, sandboxDir: string): ImageExtraction {
  const images: ExtractedImage[] = []
  const skipped: SkippedImage[] = []
  const sandboxResolved = resolve(sandboxDir)

  const stripped = body.replace(IMG_RE, (match, alt: string, rawPath: string) => {
    const path = rawPath.trim()

    // URLs and image keys: leave the original markdown — lark-cli's --markdown
    // mode auto-resolves URLs, and image keys aren't ours to interpret.
    if (/^https?:\/\//i.test(path) || /^img_[A-Za-z0-9_-]+$/.test(path)) {
      return match
    }

    // Resolve relative to sandbox dir; reject anything that escapes.
    let abs: string
    try {
      abs = isAbsolute(path) ? resolve(path) : resolve(sandboxResolved, path)
    } catch {
      skipped.push({ ref: match, reason: 'unparseable' })
      return match
    }

    const rel = relative(sandboxResolved, abs)
    if (rel.startsWith('..') || rel.startsWith(sep + '..') || isAbsolute(rel) || rel === '') {
      skipped.push({ ref: match, reason: 'escapes-sandbox' })
      return match
    }

    if (!existsSync(abs)) {
      skipped.push({ ref: match, reason: 'not-found' })
      return match
    }
    try {
      if (!statSync(abs).isFile()) {
        skipped.push({ ref: match, reason: 'not-a-file' })
        return match
      }
    } catch {
      skipped.push({ ref: match, reason: 'not-found' })
      return match
    }

    images.push({ relPath: rel, absPath: abs, alt, original: match })
    return alt ? `[图片: ${alt}]` : '[图片]'
  })

  return { images, skipped, stripped }
}
