/**
 * Builders for Feishu interactive-card JSON used by the streaming reply
 * flow. The card has four logical regions, top to bottom:
 *
 *   1. header   — state-coloured title (thinking / running / done / error)
 *   2. tools    — one line per tool call so far (max ~12 lines, oldest first)
 *   3. body     — the actual reply text, markdown-rendered. While streaming,
 *                 this shows whatever partial text we've seen; on finish,
 *                 the full final reply (with local image refs replaced by
 *                 `[图片: <alt>]` captions, same as Phase 8).
 *   4. footer   — duration / cost note + action buttons (regenerate)
 *
 * The same builder produces all states; pass `phase` to tune the header.
 *
 * Card content is deliberately kept under Feishu's "30 KB content body"
 * limit (we truncate aggressively for tool log + body), and tool entries
 * are formatted to be readable on a phone screen.
 */

export type CardPhase = 'thinking' | 'running' | 'done' | 'error' | 'aborted'

export interface ToolEntry {
  tool: string
  brief: string
  ok?: boolean
}

export interface CardOptions {
  phase: CardPhase
  /** Tool calls so far, oldest first. The renderer caps at `maxTools`. */
  tools: ToolEntry[]
  /** Reply body (markdown). Empty during early phase. */
  body: string
  /** Wall-clock seconds elapsed so far (or final). */
  durationSec?: number
  /** Cost in USD (only meaningful at `done`). */
  costUsd?: number
  /** Whether to render the regenerate button (usually `done` / `error`). */
  showActions: boolean
  /** Whether to render the stop button (usually `thinking` / `running`). */
  showStop?: boolean
}

const MAX_TOOLS_DISPLAYED = 12
const MAX_BODY_CHARS = 4000
const MAX_BRIEF_CHARS = 80

function escapeMd(s: string): string {
  // The lark_md renderer escapes most chars itself, but stray backticks in
  // tool briefs (e.g. Bash commands) break inline code. Replace ` with '.
  return s.replace(/`/g, "'")
}

function header(phase: CardPhase): Record<string, unknown> {
  switch (phase) {
    case 'thinking':
      return {
        title: { tag: 'plain_text', content: '🤔 思考中…' },
        template: 'blue',
      }
    case 'running':
      return {
        title: { tag: 'plain_text', content: '🛠 执行中' },
        template: 'turquoise',
      }
    case 'done':
      return {
        title: { tag: 'plain_text', content: '✅ 完成' },
        template: 'green',
      }
    case 'error':
      return {
        title: { tag: 'plain_text', content: '⚠️ 出错' },
        template: 'red',
      }
    case 'aborted':
      return {
        title: { tag: 'plain_text', content: '⏹ 已停止' },
        template: 'grey',
      }
  }
}

function toolsBlock(tools: ToolEntry[]): Record<string, unknown> | null {
  if (tools.length === 0) return null
  const tail = tools.slice(-MAX_TOOLS_DISPLAYED)
  const omitted = tools.length - tail.length
  const lines = tail.map((t) => {
    const icon = t.ok === false ? '❌' : t.ok === true ? '✓' : '🛠'
    const brief = escapeMd(t.brief).slice(0, MAX_BRIEF_CHARS)
    return `${icon} \`${t.tool}\` ${brief ? '· ' + brief : ''}`
  })
  if (omitted > 0) lines.unshift(`_(已省略 ${omitted} 条更早的工具调用)_`)
  return {
    tag: 'div',
    text: { tag: 'lark_md', content: lines.join('\n') },
  }
}

function bodyBlock(body: string, phase: CardPhase): Record<string, unknown> | null {
  if (!body.trim()) {
    if (phase === 'thinking' || phase === 'running') return null
    return {
      tag: 'div',
      text: { tag: 'lark_md', content: phase === 'aborted' ? '_（用户已停止）_' : '_（无输出）_' },
    }
  }
  const truncated = body.length > MAX_BODY_CHARS
  const text = truncated
    ? body.slice(0, MAX_BODY_CHARS) + `\n\n_（截断 ${body.length - MAX_BODY_CHARS} 字符）_`
    : body
  return {
    tag: 'div',
    text: { tag: 'lark_md', content: text },
  }
}

function footerNote(opts: CardOptions): Record<string, unknown> | null {
  const parts: string[] = []
  if (opts.durationSec !== undefined) parts.push(`${opts.durationSec.toFixed(1)}s`)
  if (opts.costUsd !== undefined) parts.push(`$${opts.costUsd.toFixed(4)}`)
  if (opts.tools.length > 0) parts.push(`${opts.tools.length} tool calls`)
  if (parts.length === 0) return null
  return {
    tag: 'note',
    elements: [{ tag: 'plain_text', content: parts.join(' · ') }],
  }
}

function actionBlock(opts: CardOptions): Record<string, unknown> | null {
  const actions: Array<Record<string, unknown>> = []
  if (opts.showStop) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⏹ 停止' },
      type: 'danger',
      value: { action: 'stop' },
    })
  }
  if (opts.showActions) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔄 重新生成' },
      type: 'default',
      value: { action: 'regenerate' },
    })
  }
  if (actions.length === 0) return null
  return { tag: 'action', actions }
}

/** Render a card JSON object ready to be `JSON.stringify`'d into `content`. */
export function buildCard(opts: CardOptions): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = []

  const tools = toolsBlock(opts.tools)
  if (tools) elements.push(tools)

  const body = bodyBlock(opts.body, opts.phase)
  if (body) {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    elements.push(body)
  }

  const note = footerNote(opts)
  if (note) elements.push(note)

  const actions = actionBlock(opts)
  if (actions) elements.push(actions)

  // At least one element is required for a valid card. Inject a placeholder
  // when in early thinking phase with nothing to show yet.
  if (elements.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '_（正在准备…）_' },
    })
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: header(opts.phase),
    elements,
  }
}
