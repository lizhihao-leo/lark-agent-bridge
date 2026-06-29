import { hostname, platform, release } from 'node:os'
import { config } from './config.js'
import type { Store } from './store.js'
import { getSessionId, resetSession } from './llm-claude-code.js'

/**
 * Functional slash-commands: messages starting with `/` that run a
 * built-in function instead of calling the LLM. Each handler returns a
 * `reply` (sent straight back to the chat) and, optionally, a
 * `contextNote` — a synthetic line recorded into the chat history so the
 * *next* LLM turn is aware the user ran a system command (e.g. that the
 * sandbox was turned off).
 *
 * Adding a command is one `register()` call — keep them small, fast, and
 * free of LLM calls.
 */

export interface CommandContext {
  chatId: string
  /** Raw args after the command name, split on whitespace. */
  args: string[]
  store: Store
  startedAtMs: number
}

export interface CommandResult {
  /** Markdown text sent back to the chat. */
  reply: string
  /**
   * Optional synthetic history line. Recorded as a `user` turn so the
   * next model call sees what system command ran. Omit for read-only
   * commands like /status that don't change agent behaviour.
   */
  contextNote?: string
}

export interface CommandDef {
  name: string
  /** One-line description shown by /help. */
  description: string
  handler: (ctx: CommandContext) => CommandResult | Promise<CommandResult>
}

const registry = new Map<string, CommandDef>()

export function register(def: CommandDef): void {
  registry.set(def.name, def)
}

export function listCommands(): CommandDef[] {
  return [...registry.values()]
}

/**
 * Parse a raw message into a command invocation, or return `null` if it
 * isn't a slash-command. The command name is matched greedily against
 * registered multi-word names first (so `/sandbox off` resolves to the
 * `/sandbox` command with arg `off`), then the single first token.
 */
export interface ParsedCommand {
  def: CommandDef
  args: string[]
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const tokens = trimmed.slice(1).split(/\s+/)
  const name = tokens[0]?.toLowerCase() ?? ''
  const def = registry.get(name)
  if (!def) {
    // Unknown command — represent with a synthetic "help" def so the
    // dispatcher can reply with the command list rather than calling the
    // LLM (a leading `/` is a strong signal the user meant a command).
    return { def: UNKNOWN, args: [name] }
  }
  return { def, args: tokens.slice(1) }
}

// --- Built-in commands ------------------------------------------------

const SANDBOX_KEY = 'sandbox'

/** Whether the chat currently has the sandbox lifted (`/sandbox off`). */
export function isSandboxOff(store: Store, chatId: string): boolean {
  return store.getSetting(chatId, SANDBOX_KEY) === 'off'
}

register({
  name: 'sandbox',
  description: '`/sandbox on|off` — 开启 / 关闭沙箱限制（关闭后 agent 可读写主机任意文件）',
  handler: (ctx) => {
    const mode = (ctx.args[0] ?? '').toLowerCase()
    if (mode === 'off') {
      ctx.store.setSetting(ctx.chatId, SANDBOX_KEY, 'off')
      return {
        reply:
          '⚠️ **沙箱已关闭**。Agent 现在拥有主机最高权限，可浏览 / 编辑 / 删除系统中任意文件。请谨慎操作。\n\n用 `/sandbox on` 恢复限制。',
        contextNote: '[系统命令] 用户执行了 /sandbox off：沙箱限制已解除，你现在可以访问主机上的任意绝对路径（不再局限于沙箱目录），拥有完整文件系统读写删除权限。',
      }
    }
    if (mode === 'on') {
      ctx.store.setSetting(ctx.chatId, SANDBOX_KEY, 'on')
      return {
        reply: '🔒 **沙箱已开启**。Agent 的工作目录重新限定在沙箱内。',
        contextNote: '[系统命令] 用户执行了 /sandbox on：沙箱限制已恢复，你的操作应限定在沙箱目录内。',
      }
    }
    return {
      reply:
        '用法：`/sandbox on` 或 `/sandbox off`\n\n' +
        `当前状态：${isSandboxOff(ctx.store, ctx.chatId) ? '🔓 已关闭（全权限）' : '🔒 已开启（沙箱内）'}`,
    }
  },
})

register({
  name: 'status',
  description: '`/status` — 查看系统信息、agent 配置、当前会话与 token 消耗',
  handler: (ctx) => {
    const sandboxOff = isSandboxOff(ctx.store, ctx.chatId)
    const stats = ctx.store.chatStats(ctx.chatId)
    const sessionId = config.BACKEND === 'claude-code' ? getSessionId(ctx.chatId) : undefined
    const uptimeSec = (ctx.startedAtMs ? Date.now() - ctx.startedAtMs : 0) / 1000

    const lines: string[] = [
      '**📊 系统状态**',
      '',
      '**系统**',
      `- 主机：\`${hostname()}\` (${platform()} ${release()})`,
      `- 进程已运行：${formatDuration(process.uptime())}`,
      '',
      '**Agent 配置**',
      `- 后端：\`${config.BACKEND}\``,
      `- 模型：\`${config.ANTHROPIC_MODEL}\``,
      `- 沙箱：${sandboxOff ? '🔓 已关闭（全权限）' : '🔒 已开启'}（目录 \`${config.CLAUDE_CODE_SANDBOX}\`）`,
      `- 流式卡片：${config.STREAMING_CARD ? '开' : '关'} · 超时：${config.CLAUDE_CODE_TIMEOUT_SEC}s`,
      `- 限速：${config.RATE_PER_USER_PER_MIN || '无'} 条/分钟/用户`,
      '',
      '**当前会话上下文**',
      `- Chat：\`${ctx.chatId}\``,
      sessionId ? `- Claude Code session：\`${sessionId.slice(0, 8)}…\`` : '- Claude Code session：（尚未创建）',
      `- 已记录消息数：${stats.messages}`,
      '',
      '**Token / 成本（本会话累计）**',
      `- LLM 轮次：${stats.turns}`,
      `- 累计成本：$${stats.costUsd.toFixed(4)}`,
    ]
    void uptimeSec
    return { reply: lines.join('\n') }
  },
})

register({
  name: 'new',
  description: '`/new` — 开启新会话（清空当前对话历史与 Claude Code session）',
  handler: (ctx) => {
    const removed = ctx.store.clearHistory(ctx.chatId)
    if (config.BACKEND === 'claude-code') resetSession(ctx.chatId)
    return {
      reply: `🆕 已开启新会话。清除了 ${removed} 条历史消息，Claude Code 上下文已重置。`,
      // No contextNote — there's intentionally nothing to carry forward.
    }
  },
})

register({
  name: 'help',
  description: '`/help` — 列出所有可用命令',
  handler: () => ({ reply: helpText() }),
})

function helpText(): string {
  const lines = ['**可用命令**', '']
  for (const c of listCommands()) {
    lines.push(`- ${c.description}`)
  }
  return lines.join('\n')
}

/** Synthetic def used when the user types an unrecognised `/command`. */
const UNKNOWN: CommandDef = {
  name: '__unknown__',
  description: '',
  handler: (ctx) => ({
    reply: `未知命令 \`/${ctx.args[0] ?? ''}\`。\n\n${helpText()}`,
  }),
}

function formatDuration(sec: number): string {
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${r}s`
  return `${r}s`
}
