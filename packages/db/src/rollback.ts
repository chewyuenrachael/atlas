#!/usr/bin/env node
/**
 * Atlas rollback: drop every Atlas-owned object in the `public` schema and
 * re-run all migrations from scratch.
 *
 * Destructive. Requires `--force` to run. Intended for development only.
 *
 * Usage:
 *   pnpm db:rollback --force
 *
 * @example
 * ```bash
 * pnpm db:rollback --force
 * ```
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryError, err, isErr, ok, type AtlasError, type Result } from '@atlas/core';
import { runMigrations } from './migrate.js';
import { openPgClient, readDatabaseUrl, type PgClient } from './pg-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Drop everything in the `public` schema (CASCADE) and recreate the schema,
 * then re-run all migrations.
 *
 * @returns ok() once the schema is fully reapplied.
 */
export async function rollback(opts?: {
  logger?: (msg: string) => void;
}): Promise<Result<void, AtlasError>> {
  const log = opts?.logger ?? ((m) => console.warn(m));
  const urlResult = readDatabaseUrl();
  if (isErr(urlResult)) return urlResult;

  let client: PgClient;
  try {
    client = await openPgClient(urlResult.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(new QueryError(`failed to connect: ${message}`, 'QUERY_FAILED', {}, cause));
  }
  try {
    log('DROP SCHEMA public CASCADE …');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO public');
    log('schema recreated; re-running migrations');
  } catch (cause) {
    await client.end();
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(new QueryError(`rollback drop failed: ${message}`, 'QUERY_FAILED', {}, cause));
  }
  await client.end();

  const result = await runMigrations({ logger: log });
  if (isErr(result)) return result;
  log(`rollback complete; applied ${result.value.applied.length} migrations`);
  return ok(undefined);
}

const isMain = (): boolean => {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === __filename;
};

if (isMain()) {
  void (async () => {
    if (!process.argv.includes('--force')) {
      console.error(
        'refusing to run without --force; this command drops every table in the public schema',
      );
      process.exit(2);
    }
    const result = await rollback({ logger: (m) => console.warn(m) });
    if (isErr(result)) {
      console.error('rollback failed:', result.error.message, result.error.context);
      process.exit(1);
    }
  })();
}
