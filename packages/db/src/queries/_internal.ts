/**
 * Internal helpers shared across query modules. Not exported from
 * `@atlas/db`; importable only from sibling query files via relative path.
 *
 * Centralizes Supabase-error → AtlasError mapping so every helper produces a
 * consistent shape regardless of which entity it touched.
 */
import {
  QueryError,
  err,
  ok,
  type AtlasError,
  type AtlasErrorCode,
  type Result,
} from '@atlas/core';
import { getServiceClient, type SupabaseClient } from '../client.js';

/** Result of a Supabase PostgREST call: `{ data, error }`. */
export interface SbResult<T> {
  data: T | null;
  error: { message: string; details?: string; hint?: string; code?: string } | null;
}

/** Acquire the memoized service-role client or surface the env error. */
export function svc(): Result<SupabaseClient, AtlasError> {
  return getServiceClient();
}

/** Translate a Supabase error into an `AtlasError` with consistent context. */
export function toQueryError(
  helper: string,
  cause: SbResult<unknown>['error'],
  extra: Record<string, unknown> = {},
): AtlasError {
  const code: AtlasErrorCode = cause?.code === 'PGRST116' ? 'QUERY_NOT_FOUND' : 'QUERY_FAILED';
  return new QueryError(`${helper}: ${cause?.message ?? 'unknown supabase error'}`, code, {
    helper,
    pgrstCode: cause?.code,
    details: cause?.details,
    hint: cause?.hint,
    ...extra,
  });
}

/** Wrap a Supabase call result, returning `Result` with the typed payload. */
export function envelope<T>(
  helper: string,
  result: SbResult<T>,
  extra: Record<string, unknown> = {},
): Result<T, AtlasError> {
  if (result.error) return err(toQueryError(helper, result.error, extra));
  if (result.data === null) {
    return err(new QueryError(`${helper}: no data returned`, 'QUERY_FAILED', { helper, ...extra }));
  }
  return ok(result.data);
}

/**
 * pgvector wire format. The Supabase REST API serializes `vector` columns as
 * a JSON string of the form `"[0.1,0.2,...]"`. Normalize to `number[]` for
 * application code.
 */
export function parseVector(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Format a vector for write. pgvector accepts `'[a,b,c]'` text input. */
export function formatVector(vec: number[] | null | undefined): string | null {
  if (!vec) return null;
  return `[${vec.join(',')}]`;
}

/** Defensive guard: ensure an ID-like result was actually returned. */
export function ensureRow<T>(helper: string, row: T | null): Result<T, AtlasError> {
  if (row === null) return err(new QueryError(`${helper}: row not found`, 'QUERY_NOT_FOUND'));
  return ok(row);
}
