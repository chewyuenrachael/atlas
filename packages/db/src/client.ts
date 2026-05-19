/**
 * Supabase client wrapper.
 *
 * Two clients are exposed:
 *   - `getAnonClient()` — RLS-respecting, safe for browser/server reads.
 *   - `getServiceClient()` — bypasses RLS, server-only. Never expose to a
 *     browser bundle. Always import behind a server-only boundary.
 *
 * Configuration is read from env vars (see `.env.example`). The client is
 * created once per process and reused — Supabase's PostgREST keeps an HTTP
 * connection pool internally.
 *
 * @example
 * ```ts
 * import { getServiceClient } from '@atlas/db';
 *
 * const supabase = getServiceClient();
 * const { data, error } = await supabase.from('person').select('id').eq('id', personId).single();
 * ```
 */
import { ConfigError, type AtlasError, type Result, err, ok } from '@atlas/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let anonClient: SupabaseClient | null = null;
let serviceClient: SupabaseClient | null = null;

function readUrl(): Result<string, AtlasError> {
  const url = process.env['SUPABASE_URL'];
  if (!url)
    return err(
      new ConfigError('SUPABASE_URL not set', 'INVALID_CONFIG', { missing: ['SUPABASE_URL'] }),
    );
  return ok(url);
}

function readAnonKey(): Result<string, AtlasError> {
  const key = process.env['SUPABASE_ANON_KEY'];
  if (!key)
    return err(
      new ConfigError('SUPABASE_ANON_KEY not set', 'INVALID_CONFIG', {
        missing: ['SUPABASE_ANON_KEY'],
      }),
    );
  return ok(key);
}

function readServiceRoleKey(): Result<string, AtlasError> {
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!key)
    return err(
      new ConfigError('SUPABASE_SERVICE_ROLE_KEY not set', 'INVALID_CONFIG', {
        missing: ['SUPABASE_SERVICE_ROLE_KEY'],
      }),
    );
  return ok(key);
}

/**
 * Anonymous client. Honors Postgres Row-Level Security policies. Safe for
 * use from request handlers that should run as the calling user.
 */
export function getAnonClient(): Result<SupabaseClient, AtlasError> {
  if (anonClient) return ok(anonClient);
  const url = readUrl();
  if (!url.ok) return url;
  const key = readAnonKey();
  if (!key.ok) return key;
  anonClient = createClient(url.value, key.value, {
    auth: { persistSession: false },
  });
  return ok(anonClient);
}

/**
 * Service-role client. Bypasses RLS. Server-only. Used by Inngest workflows,
 * source adapters, and admin scripts.
 */
export function getServiceClient(): Result<SupabaseClient, AtlasError> {
  if (serviceClient) return ok(serviceClient);
  const url = readUrl();
  if (!url.ok) return url;
  const key = readServiceRoleKey();
  if (!key.ok) return key;
  serviceClient = createClient(url.value, key.value, {
    auth: { persistSession: false },
    db: { schema: 'public' },
  });
  return ok(serviceClient);
}

/** Test-only: reset memoized clients between tests. */
export function __resetClientsForTesting(): void {
  anonClient = null;
  serviceClient = null;
}

export type { SupabaseClient } from '@supabase/supabase-js';
