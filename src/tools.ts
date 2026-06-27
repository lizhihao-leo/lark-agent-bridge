import { runCli } from './lark/cli.js'
import { logger } from './logger.js'

/**
 * Tool definitions exposed to the LLM. Each tool is a small, audited wrapper
 * around a single lark-cli subcommand. We deliberately do NOT auto-expose the
 * full CLI surface — that would let the LLM call things like `auth logout`,
 * `config remove`, or send broadcast messages with no human consent.
 *
 * The whitelist below covers the high-value read paths plus one carefully
 * scoped write path (`lark_send_text`) that requires an already-known
 * `chat_id` — the LLM cannot enumerate chats to discover targets.
 */

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for input_schema, per Anthropic tool-use spec. */
  input_schema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
  /** Map input args to lark-cli argv. */
  run: (input: Record<string, unknown>) => Promise<unknown>
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  if (typeof v !== 'string') throw new Error(`tool input '${key}' must be a string`)
  return v
}

function strOpt(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new Error(`tool input '${key}' must be a string`)
  return v
}

function numOpt(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number') throw new Error(`tool input '${key}' must be a number`)
  return v
}

export const TOOLS: ToolDef[] = [
  {
    name: 'lark_search_messages',
    description:
      'Search recent messages across all chats the bot can see. Returns matching message snippets with chat_id, sender, and message_id. User identity recommended for better recall.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search for' },
        limit: { type: 'number', description: 'Max results to return (1-50)' },
      },
      required: ['query'],
    },
    run: async (input) => {
      const argv = ['im', '+messages-search', '--as', 'user', '--query', str(input, 'query')]
      const limit = numOpt(input, 'limit')
      if (limit !== undefined) argv.push('--page-size', String(Math.min(50, Math.max(1, limit))))
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_chat_messages_list',
    description:
      'List recent messages in a specific chat. Useful for catching up on a conversation. Provide chat_id (oc_...) OR user_id (ou_...) for a P2P thread.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID (oc_...)' },
        user_id: { type: 'string', description: 'User open_id (ou_...) for a 1:1 thread' },
        limit: { type: 'number', description: 'Max messages (1-50)' },
      },
    },
    run: async (input) => {
      const chatId = strOpt(input, 'chat_id')
      const userId = strOpt(input, 'user_id')
      if (!chatId && !userId) throw new Error('chat_id or user_id is required')
      const argv = ['im', '+chat-messages-list', '--as', 'user']
      if (chatId) argv.push('--chat-id', chatId)
      else if (userId) argv.push('--user-id', userId)
      const limit = numOpt(input, 'limit')
      if (limit !== undefined) argv.push('--page-size', String(Math.min(50, Math.max(1, limit))))
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_doc_read',
    description:
      'Fetch the plain-text content of a Feishu Docs document by its token. Useful when the user pastes a docs link and asks about its content.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'Document token (the alphanumeric ID in the URL)' },
      },
      required: ['document_id'],
    },
    run: async (input) => {
      const id = str(input, 'document_id')
      const r = await runCli([
        'docs',
        '+document-raw-content',
        '--as',
        'user',
        '--document-id',
        id,
      ])
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_base_records_search',
    description:
      'Search records in a Feishu Base (multi-dimensional table). Returns matching rows.',
    input_schema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'Base app token (bascn...)' },
        table_id: { type: 'string', description: 'Table ID (tbl...)' },
        page_size: { type: 'number', description: 'Page size (1-100)' },
      },
      required: ['app_token', 'table_id'],
    },
    run: async (input) => {
      const argv = [
        'base',
        '+record-search',
        '--as',
        'user',
        '--app-token',
        str(input, 'app_token'),
        '--table-id',
        str(input, 'table_id'),
      ]
      const ps = numOpt(input, 'page_size')
      if (ps !== undefined) argv.push('--page-size', String(Math.min(100, Math.max(1, ps))))
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_send_text',
    description:
      'Send a plain-text message to a specific chat_id or user_id (P2P). DO NOT use this to enumerate or broadcast — only send when the user explicitly asked you to.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID (oc_...)' },
        user_id: { type: 'string', description: 'User open_id (ou_...)' },
        text: { type: 'string', description: 'Plain-text body' },
      },
      required: ['text'],
    },
    run: async (input) => {
      const chatId = strOpt(input, 'chat_id')
      const userId = strOpt(input, 'user_id')
      if (!chatId && !userId) throw new Error('chat_id or user_id is required')
      const argv = ['im', '+messages-send', '--as', 'bot', '--text', str(input, 'text')]
      if (chatId) argv.push('--chat-id', chatId)
      else if (userId) argv.push('--user-id', userId)
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
]

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]))

/** Format for Anthropic SDK — strip the runtime `run` method. */
export function anthropicTools(): Array<{
  name: string
  description: string
  input_schema: ToolDef['input_schema']
}> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const t = TOOL_MAP.get(name)
  if (!t) throw new Error(`unknown tool: ${name}`)
  logger.info({ tool: name, input }, 'executing tool')
  try {
    const out = await t.run(input)
    logger.debug({ tool: name }, 'tool ok')
    return out
  } catch (err) {
    const e = err as { message?: string }
    logger.error({ tool: name, err: e.message }, 'tool execution failed')
    return { error: e.message ?? String(err) }
  }
}
