/**
 * Per-user token bucket. Each user gets `capacity` tokens; one token is
 * consumed per accepted message. Tokens refill at `refillPerSec` =
 * capacity / 60 (so a `capacity` of 6 means "6 per minute, smoothly
 * refilled").
 *
 * We don't bother with a sweep/eviction pass — entries are tiny and
 * stale ones simply never reach back to capacity above their last
 * recorded `tokens`. For a single-host bot the memory cost is bounded
 * by the size of the user base, which is fine.
 *
 * `try_consume()` returns `{ ok: true }` when the message is allowed,
 * `{ ok: false, retryAfterSec }` when the user is throttled (the
 * caller surfaces this to the chat).
 */

export interface TryConsumeResult {
  ok: boolean
  /** Seconds until the next token is available; only set when `ok: false`. */
  retryAfterSec?: number
}

interface Bucket {
  tokens: number
  lastRefillMs: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly refillPerSec: number

  constructor(
    private readonly capacity: number,
    /** Window length the capacity is spread over. Default: 60 s. */
    windowSec = 60,
  ) {
    this.refillPerSec = capacity / windowSec
  }

  tryConsume(key: string, now = Date.now()): TryConsumeResult {
    if (this.capacity <= 0) return { ok: true } // disabled
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: this.capacity, lastRefillMs: now }
      this.buckets.set(key, b)
    } else {
      const elapsedSec = (now - b.lastRefillMs) / 1000
      b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec)
      b.lastRefillMs = now
    }
    if (b.tokens >= 1) {
      b.tokens -= 1
      return { ok: true }
    }
    const needed = 1 - b.tokens
    const retryAfterSec = needed / this.refillPerSec
    return { ok: false, retryAfterSec }
  }
}
