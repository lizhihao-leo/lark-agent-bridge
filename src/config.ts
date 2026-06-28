import { z } from 'zod'
import { config as loadDotenv } from 'dotenv'

loadDotenv()

const Env = z.object({
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().min(1, 'ANTHROPIC_AUTH_TOKEN is required'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-6'),

  LARK_EVENT_KEY: z.string().min(1).default('im.message.receive_v1'),
  LARK_EVENT_AS: z.enum(['bot', 'user', 'auto']).default('bot'),

  MAX_INPUT_CHARS: z.coerce.number().int().positive().default(4000),
  MAX_HISTORY_TURNS: z.coerce.number().int().positive().default(12),
  MAX_TOKENS_REPLY: z.coerce.number().int().positive().default(1024),

  STORE_PATH: z.string().min(1).default('data/bridge.sqlite'),
  SEEN_EVENT_TTL_DAYS: z.coerce.number().int().positive().default(7),

  /**
   * Group-chat policy:
   *   - 'mention': only react when content starts with '@'  (default; matches
   *     Feishu's normal "bot @-mentioned" delivery semantics where lark-cli
   *     pre-renders the @-prefix into the content string).
   *   - 'all'    : react to every message in any group the bot is in.
   *   - 'off'    : ignore group messages entirely.
   * P2P (private) messages always go through regardless of this setting.
   */
  GROUP_TRIGGER: z.enum(['mention', 'all', 'off']).default('mention'),

  /** Optional bot display-name prefix to strip from group content before sending to LLM. */
  BOT_AT_PREFIX: z.string().default(''),

  /**
   * Enable the LLM tool-use loop. Requires a model that supports the
   * Anthropic tools API (Claude on api.anthropic.com always; ARK and other
   * compatibility proxies vary — verify before enabling).
   */
  ENABLE_TOOLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Backend strategy:
   *   - 'anthropic-sdk' (default): one HTTP call per message via the Anthropic
   *     SDK. Cheap, fast, but only as capable as the underlying model.
   *   - 'claude-code'  : spawn a headless Claude Code CLI per message. Gives
   *     you the full agentic loop (Bash/Read/Write/Edit/Grep, multi-step
   *     planning, MCP, hooks if --bare is off). Higher latency and cost.
   *     The CLI uses the same ANTHROPIC_* env, so it routes to your provider.
   */
  BACKEND: z.enum(['anthropic-sdk', 'claude-code']).default('anthropic-sdk'),

  /**
   * For BACKEND=claude-code: working directory for spawned Claude Code
   * sessions. Treated as a sandbox — Claude Code can read/write inside it,
   * --add-dir is NOT used so it cannot escape upward.
   */
  CLAUDE_CODE_SANDBOX: z.string().min(1).default('/home/leo/lark-bot-sandbox'),

  /** Per-message timeout for the claude-code subprocess (seconds). */
  CLAUDE_CODE_TIMEOUT_SEC: z.coerce.number().int().positive().default(180),

  /**
   * Extra args appended to `claude -p ...` (space-separated). Useful for
   * --allowedTools, --append-system-prompt, etc.
   */
  CLAUDE_CODE_EXTRA_ARGS: z.string().default(''),

  /**
   * Send an immediate "⏳ 思考中…" placeholder to Feishu while Claude Code
   * is running, then recall it after the real reply lands. Improves UX for
   * the multi-second latency without needing interactive cards. Only
   * affects BACKEND=claude-code.
   */
  SHOW_THINKING_PLACEHOLDER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  // Don't use the logger here — logger depends on this config.
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors)
  process.exit(2)
}

export const config = parsed.data
export type Config = typeof config
