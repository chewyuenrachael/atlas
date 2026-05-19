/**
 * Exponential backoff retry helper (SPEC.md §5.4).
 *
 * Adapters call `withRetry` around any network-bound operation. Inngest also
 * retries failed steps at the workflow level — `withRetry` exists for inline
 * operations inside a single Inngest step where re-running the whole step is
 * undesirable (e.g. partial pagination consumed).
 */
import { fromUnknown, type AtlasError, type AtlasErrorCode } from '@atlas/core';

export interface RetryOptions {
  /** Maximum number of attempts including the initial one. Default 5. */
  maxAttempts?: number;
  /** Initial delay in ms before the first retry. Default 250. */
  initialDelayMs?: number;
  /** Multiplier applied between attempts. Default 2. */
  factor?: number;
  /** Hard cap on per-delay backoff. Default 1 hour. */
  maxDelayMs?: number;
  /** Optional jitter [0..1]. 0 = none, 1 = full ± delay. Default 0.2. */
  jitter?: number;
  /** Predicate: returning `false` aborts the retry loop. Default: always retry. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** AtlasErrorCode applied if all attempts fail and the cause is not an AtlasError. */
  fallbackCode?: AtlasErrorCode;
}

/**
 * Run `fn`. On thrown error, retry with exponential backoff up to
 * `maxAttempts`. Returns the value or throws the final error as an AtlasError.
 *
 * Adapters generally prefer returning a Result rather than throwing — wrap
 * `withRetry` inside `tryAsync` at the boundary.
 *
 * @example
 * ```ts
 * const html = await withRetry(() => fetch(url).then(r => r.text()), { maxAttempts: 3 });
 * ```
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 250;
  const factor = options.factor ?? 2;
  const maxDelayMs = options.maxDelayMs ?? 60 * 60 * 1000;
  const jitter = options.jitter ?? 0.2;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const fallbackCode: AtlasErrorCode = options.fallbackCode ?? 'EXTERNAL_API_ERROR';

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (cause) {
      lastError = cause;
      if (attempt === maxAttempts || !shouldRetry(cause, attempt)) break;
      const base = Math.min(maxDelayMs, initialDelayMs * factor ** (attempt - 1));
      const noise = base * jitter * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.floor(base + noise));
      await sleep(delay);
    }
  }
  const wrapped: AtlasError = fromUnknown(lastError, fallbackCode, { maxAttempts });
  throw wrapped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
