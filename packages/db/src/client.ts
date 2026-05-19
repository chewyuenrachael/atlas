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

interface SupabaseEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

function readEnv(): Result<SupabaseEnv, AtlasError> {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  const missing: string[] = [];
  if (!url) missing.push('SUPABASE_URL');
  if (!anonKey) missing.push('SUPABASE_ANON_KEY');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0 || !url || !anonKey || !serviceRoleKey) {
    return err(
      new ConfigError(
        `Supabase env vars missing: ${missing.join(', ')}`,
        'INVALID_CONFIG',
        { missing },
      ),
    );
  }
  return ok({ url, anonKey, serviceRoleKey });
}

/**
 * Anonymous client. Honors Postgres Row-Level Security policies. Safe for
 * use from request handlers that should run as the calling user.
 */
export function getAnonClient(): Result<SupabaseClient, AtlasError> {
  if (anonClient) return ok(anonClient);
  const envResult = readEnv();
  if (!envResult.ok) return envResult;
  anonClient = createClient(envResult.value.url, envResult.value.anonKey, {
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
  const envResult = readEnv();
  if (!envResult.ok) return envResult;
  serviceClient = createClient(envResult.value.url, envResult.value.serviceRoleKey, {
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
