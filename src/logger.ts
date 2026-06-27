import pino from 'pino'
import { config } from './config.js'

// Pretty-print in TTY, structured JSON otherwise — Docker/systemd will see JSON.
// Conditional spread avoids passing `transport: undefined`, which breaks
// pino's typing under exactOptionalPropertyTypes.
export const logger = pino({
  level: config.LOG_LEVEL,
  ...(process.stdout.isTTY
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
})
