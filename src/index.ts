#!/usr/bin/env node
import { run } from './worker.js'
import { logger } from './logger.js'

const { stop } = run()

let exiting = false
function shutdown(sig: NodeJS.Signals): void {
  if (exiting) return
  exiting = true
  logger.info({ sig }, 'shutting down')
  stop()
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'))
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'))
