#!/usr/bin/env node
/**
 * Atlas migration runner.
 *
 * Reads every `*.sql` file in `infra/migrations/` (sorted lexicographically),
 * applies pending migrations inside a single transaction each, and tracks
 * progress in `_atlas_migrations`. Re-running is safe: already-applied
 * migrations are skipped after a checksum drift check (warn-only).
 *
 * Usage:
 *   pnpm db:migrate
 *
 * @example
 * ```ts
 * import { runMigrations } from '@atlas/db/migrate';
 * const result = await runMigrations();
 * if (!result.ok) process.exit(1);
 * ```
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, QueryError, err, isErr, ok, type AtlasError, type Result } from '@atlas/core';
import { openPgClient, readDatabaseUrl, type PgClient } from './pg-client.js';

const MIGRATIONS_TABLE = '_atlas_migrations';

export interface MigrationRecord {
  filename: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationRunReport {
  applied: { filename: string; durationMs: number }[];
  skipped: string[];
  drift: { filename: string; expected: string; actual: string }[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the `infra/migrations/` directory relative to this file. */
export function defaultMigrationsDir(): string {
  return resolve(__dirname, '..', '..', '..', 'infra', 'migrations');
}

/** SHA-256 hex digest of a UTF-8 string. */
export function checksum(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

interface PendingMigration {
  filename: string;
  body: string;
  checksum: string;
}

async function loadMigrations(dir: string): Promise<PendingMigration[]> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  const out: PendingMigration[] = [];
  for (const filename of files) {
    const body = await readFile(join(dir, filename), 'utf8');
    out.push({ filename, body, checksum: checksum(body) });
  }
  return out;
}

async function ensureMigrationsTable(client: PgClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function fetchApplied(client: PgClient): Promise<Map<string, string>> {
  const result = await client.query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM ${MIGRATIONS_TABLE} ORDER BY filename ASC`,
  );
  const map = new Map<string, string>();
  for (const row of result.rows) map.set(row.filename, row.checksum);
  return map;
}

async function applyOne(
  client: PgClient,
  migration: PendingMigration,
): Promise<Result<number, AtlasError>> {
  const t0 = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(migration.body);
    await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (filename, checksum) VALUES ($1, $2)`, [
      migration.filename,
      migration.checksum,
    ]);
    await client.query('COMMIT');
    return ok(Date.now() - t0);
  } catch (cause) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore secondary failure during rollback
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(
      new QueryError(`migration ${migration.filename} failed: ${message}`, 'QUERY_FAILED', {
        filename: migration.filename,
      }),
    );
  }
}

/**
 * Apply all pending migrations against the database referenced by
 * `DATABASE_URL`. Returns a structured report on success.
 */
export async function runMigrations(opts?: {
  migrationsDir?: string;
  logger?: (msg: string) => void;
}): Promise<Result<MigrationRunReport, AtlasError>> {
  const log = opts?.logger ?? ((m) => console.warn(m));
  const dir = opts?.migrationsDir ?? defaultMigrationsDir();

  const urlResult = readDatabaseUrl();
  if (isErr(urlResult)) return urlResult;

  let client: PgClient;
  try {
    client = await openPgClient(urlResult.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(
      new ConfigError(`failed to connect to database: ${message}`, 'INVALID_CONFIG', {}, cause),
    );
  }

  const report: MigrationRunReport = { applied: [], skipped: [], drift: [] };
  try {
    await ensureMigrationsTable(client);
    const applied = await fetchApplied(client);
    const pending = await loadMigrations(dir);

    if (pending.length === 0) {
      log('no migration files found in ' + dir);
    }

    for (const migration of pending) {
      const previousChecksum = applied.get(migration.filename);
      if (previousChecksum) {
        if (previousChecksum !== migration.checksum) {
          report.drift.push({
            filename: migration.filename,
            expected: previousChecksum,
            actual: migration.checksum,
          });
          log(
            `WARN drift detected for ${migration.filename}: applied checksum ${previousChecksum} != on-disk ${migration.checksum}`,
          );
        }
        report.skipped.push(migration.filename);
        log(`skip ${migration.filename} (already applied)`);
        continue;
      }
      log(`apply ${migration.filename}…`);
      const result = await applyOne(client, migration);
      if (isErr(result)) return result;
      report.applied.push({ filename: migration.filename, durationMs: result.value });
      log(`  ✓ ${migration.filename} in ${result.value}ms`);
    }
  } finally {
    await client.end();
  }
  return ok(report);
}

const isMain = (): boolean => {
  if (!process.argv[1]) return false;
  const invoked = resolve(process.argv[1]);
  return invoked === __filename;
};

if (isMain()) {
  void (async () => {
    const result = await runMigrations({ logger: (m) => console.warn(m) });
    if (isErr(result)) {
      console.error('migration failed:', result.error.message, result.error.context);
      process.exit(1);
    }
    const r = result.value;
    console.warn(
      `migrations done: ${r.applied.length} applied, ${r.skipped.length} skipped, ${r.drift.length} drift warnings`,
    );
  })();
}
