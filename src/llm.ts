import Anthropic from '@anthropic-ai/sdk'
import { config } from './config.js'
import { logger } from './logger.js'

/**
 * Thin wrapper around the Anthropic SDK so the rest of the codebase doesn't
 * directly depend on its types. In Phase 4 this becomes a Strategy with
 * pluggable providers (Bedrock, OpenAI-compat, etc.); for now there's one
 * provider and the indirection is just so we can swap it without touching
 * the worker.
 */

const client = new Anthropic({
  ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
  authToken: config.ANTHROPIC_AUTH_TOKEN,
})

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  text: string
  inputTokens: number
  outputTokens: number
  modelEcho: string
}

export async function chat(messages: ChatMessage[]): Promise<ChatResult> {
  const resp = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: config.MAX_TOKENS_REPLY,
    messages,
  })
  const text =
    resp.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim() || '(empty response)'
  logger.debug(
    { model: resp.model, in: resp.usage.input_tokens, out: resp.usage.output_tokens },
    'chat ok',
  )
  return {
    text,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
    modelEcho: resp.model,
  }
}
