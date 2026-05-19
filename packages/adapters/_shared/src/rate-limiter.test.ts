import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  it('serves the initial burst without delay', async () => {
    const limiter = new RateLimiter({ maxRequestsPerInterval: 5, intervalMs: 1000 });
    const start = Date.now();
    for (let i = 0; i < 5; i += 1) await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('rejects requests larger than capacity', async () => {
    const limiter = new RateLimiter({ maxRequestsPerInterval: 2, intervalMs: 1000 });
    await expect(limiter.acquire(5)).rejects.toThrow();
  });

  it('throws on invalid config', () => {
    expect(() => new RateLimiter({ maxRequestsPerInterval: 0, intervalMs: 100 })).toThrow();
    expect(() => new RateLimiter({ maxRequestsPerInterval: 10, intervalMs: 0 })).toThrow();
  });
});
