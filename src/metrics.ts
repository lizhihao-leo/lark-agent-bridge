import { createServer } from 'node:http'
import { logger } from './logger.js'

/**
 * Minimal in-process Prometheus exposition. We deliberately do NOT pull
 * in `prom-client`: the metric set is small, the format is plain text,
 * and the bridge's whole appeal is being a few-files Node program.
 *
 * Conventions:
 *   - Counter values are monotonically non-decreasing `number`s.
 *   - Histogram buckets are le-strings; sum/count tracked separately.
 *   - All metrics use the `larkbridge_` prefix.
 *   - Labels are passed as a flat object; we serialise in stable key
 *     order so prometheus scrapers see consistent series.
 */

type LabelSet = Record<string, string>

interface CounterSeries {
  labels: LabelSet
  value: number
}

interface HistogramSeries {
  labels: LabelSet
  buckets: Map<number, number> // upper-bound (s) → cumulative count
  sum: number
  count: number
}

class Counter {
  private readonly series = new Map<string, CounterSeries>()

  constructor(readonly name: string, readonly help: string) {}

  inc(labels: LabelSet = {}, by = 1): void {
    const k = serializeLabels(labels)
    const s = this.series.get(k)
    if (s) s.value += by
    else this.series.set(k, { labels, value: by })
  }

  expose(): string {
    const lines: string[] = []
    lines.push(`# HELP ${this.name} ${this.help}`)
    lines.push(`# TYPE ${this.name} counter`)
    for (const s of this.series.values()) {
      lines.push(`${this.name}${formatLabels(s.labels)} ${s.value}`)
    }
    return lines.join('\n')
  }
}

class Histogram {
  private readonly series = new Map<string, HistogramSeries>()
  private readonly bucketBounds: number[]

  constructor(readonly name: string, readonly help: string, bucketBounds: number[]) {
    // Sorted ascending, plus +Inf appended for the standard final bucket.
    this.bucketBounds = [...bucketBounds].sort((a, b) => a - b)
  }

  observe(labels: LabelSet, value: number): void {
    const k = serializeLabels(labels)
    let s = this.series.get(k)
    if (!s) {
      s = { labels, buckets: new Map(this.bucketBounds.map((b) => [b, 0])), sum: 0, count: 0 }
      this.series.set(k, s)
    }
    s.sum += value
    s.count += 1
    for (const b of this.bucketBounds) {
      if (value <= b) s.buckets.set(b, (s.buckets.get(b) ?? 0) + 1)
    }
  }

  expose(): string {
    const lines: string[] = []
    lines.push(`# HELP ${this.name} ${this.help}`)
    lines.push(`# TYPE ${this.name} histogram`)
    for (const s of this.series.values()) {
      for (const b of this.bucketBounds) {
        const ls = { ...s.labels, le: b.toString() }
        lines.push(`${this.name}_bucket${formatLabels(ls)} ${s.buckets.get(b) ?? 0}`)
      }
      const lsInf = { ...s.labels, le: '+Inf' }
      lines.push(`${this.name}_bucket${formatLabels(lsInf)} ${s.count}`)
      lines.push(`${this.name}_sum${formatLabels(s.labels)} ${s.sum}`)
      lines.push(`${this.name}_count${formatLabels(s.labels)} ${s.count}`)
    }
    return lines.join('\n')
  }
}

function serializeLabels(l: LabelSet): string {
  const keys = Object.keys(l).sort()
  return keys.map((k) => `${k}=${l[k]}`).join(',')
}

function formatLabels(l: LabelSet): string {
  const keys = Object.keys(l).sort()
  if (keys.length === 0) return ''
  const parts = keys.map((k) => `${k}="${String(l[k]).replace(/"/g, '\\"')}"`)
  return `{${parts.join(',')}}`
}

// -- Registry ----------------------------------------------------------

export const metrics = {
  messagesTotal: new Counter(
    'larkbridge_messages_total',
    'Incoming Feishu messages accepted by the bridge, by message type and backend.',
  ),
  messagesDropped: new Counter(
    'larkbridge_messages_dropped_total',
    'Messages dropped before reaching the LLM, by reason (allowlist / rate_limited / unsupported_type / group_filter).',
  ),
  llmCalls: new Counter(
    'larkbridge_llm_calls_total',
    'Completed LLM turns, by backend and outcome (success / error / aborted).',
  ),
  llmCostUsd: new Counter(
    'larkbridge_llm_cost_usd_total',
    'Cumulative reported LLM cost in USD (claude-code backend only; anthropic-sdk does not report).',
  ),
  llmToolCalls: new Counter(
    'larkbridge_llm_tool_calls_total',
    'Cumulative tool_use events the model emitted across all turns.',
  ),
  llmLatencySec: new Histogram(
    'larkbridge_llm_latency_seconds',
    'End-to-end LLM round-trip time per message, in seconds.',
    [0.5, 1, 2, 5, 10, 20, 45, 90, 180],
  ),
  cardPatches: new Counter(
    'larkbridge_card_patches_total',
    'Total interactive-card PATCH requests sent, by outcome (ok / fail).',
  ),
  cardActions: new Counter(
    'larkbridge_card_actions_total',
    'Card-action callbacks received, by action name (regenerate / stop / unknown).',
  ),
}

function exposeAll(): string {
  return [
    metrics.messagesTotal.expose(),
    metrics.messagesDropped.expose(),
    metrics.llmCalls.expose(),
    metrics.llmCostUsd.expose(),
    metrics.llmToolCalls.expose(),
    metrics.llmLatencySec.expose(),
    metrics.cardPatches.expose(),
    metrics.cardActions.expose(),
  ].join('\n\n') + '\n'
}

/**
 * Start an HTTP server exposing `/metrics` in Prometheus text format.
 * Returns the close handle so the worker can shut it down cleanly.
 */
export function startMetricsServer(port: number, host = '127.0.0.1'): { stop: () => Promise<void> } {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end(exposeAll())
      return
    }
    if (req.url === '/' || req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n')
      return
    }
    res.writeHead(404).end()
  })
  server.listen(port, host, () => {
    logger.info({ host, port }, 'metrics server listening')
  })
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
