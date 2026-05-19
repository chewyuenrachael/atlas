/**
 * Raw Postgres client wrapper for migrations and admin scripts.
 *
 * The Supabase JS client (`./client.ts`) is the right entry point for
 * application code — it speaks PostgREST and respects RLS. Schema migrations
 * and the bootstrap smoke test need a real Postgres connection so DDL,
 * extensions, materialized views, and arbitrary SQL can execute. Those code
 * paths use this thin wrapper around `pg.Client`.
 *
 * Never import this from adapters, workflows, or API routes — it bypasses
 * every guardrail and is reserved for `packages/db/src/migrate.ts`,
 * `rollback.ts`, and the smoke test.
 */
import { ConfigError, type AtlasError, type Result, err, ok } from '@atlas/core';
import pg from 'pg';

const { Client } = pg;
export type PgClient = pg.Client;

/**
 * Read the Postgres connection string from the environment.
 *
 * @example
 * ```ts
 * const url = readDatabaseUrl();
 * if (!url.ok) throw url.error;
 * const client = await openPgClient(url.value);
 * ```
 */
export function readDatabaseUrl(): Result<string, AtlasError> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    return err(
      new ConfigError(
        'DATABASE_URL not set; required for migrations and admin scripts',
        'INVALID_CONFIG',
        { missing: ['DATABASE_URL'] },
      ),
    );
  }
  return ok(url);
}

/**
 * Open a `pg.Client` against the given connection string and wait for connect.
 *
 * Supabase pooler endpoints terminate TLS with a managed cert; we accept the
 * provided chain unconditionally because the alternative (bundling Supabase's
 * root CA) bloats the package without buying anything for an internal tool.
 */
export async function openPgClient(databaseUrl: string): Promise<PgClient> {
  const useSsl = !/localhost|127\.0\.0\.1/.test(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  return client;
}
