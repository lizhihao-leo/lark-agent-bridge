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
