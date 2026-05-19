/**
 * Token-bucket rate limiter (SPEC.md §5.5).
 *
 * In-memory only. Each adapter instance owns one limiter. For horizontally
 * scaled deployments, swap this for a Redis-backed implementation behind the
 * same `acquire()` contract — adapter code does not need to change.
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter({ maxRequestsPerInterval: 60, intervalMs: 60_000 });
 * await limiter.acquire(); // resolves when a token is available
 * await client.fetch();
 * ```
 */
import type { RateLimitConfig } from '@atlas/core';

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefillAt: number;

  constructor(config: RateLimitConfig) {
    if (config.maxRequestsPerInterval <= 0 || config.intervalMs <= 0) {
      throw new Error(
        `RateLimiter: invalid config (max=${config.maxRequestsPerInterval}, interval=${config.intervalMs})`,
      );
    }
    this.capacity = config.burst ?? config.maxRequestsPerInterval;
    this.refillPerMs = config.maxRequestsPerInterval / config.intervalMs;
    this.tokens = this.capacity;
    this.lastRefillAt = Date.now();
  }

  /** Block until `count` tokens are available, then debit them. */
  async acquire(count = 1): Promise<void> {
    if (count > this.capacity) {
      throw new Error(`RateLimiter: requested ${count} > capacity ${this.capacity}`);
    }
    while (true) {
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      const deficit = count - this.tokens;
      const waitMs = Math.max(1, Math.ceil(deficit / this.refillPerMs));
      await sleep(waitMs);
    }
  }

  /** Inspect remaining tokens without modifying state. Mainly for tests. */
  remaining(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    const added = elapsed * this.refillPerMs;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillAt = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
