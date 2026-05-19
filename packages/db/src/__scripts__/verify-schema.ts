#!/usr/bin/env node
/**
 * Verification script: print a summary of tables, indexes, materialized views,
 * functions, and extensions in the public schema. Used by Phase 1A to confirm
 * the initial schema migration applied cleanly.
 *
 * Usage: node --env-file=.env --import tsx packages/db/src/__scripts__/verify-schema.ts
 */
import { isErr } from '@atlas/core';
import { openPgClient, readDatabaseUrl } from '../pg-client.js';

async function main() {
  const url = readDatabaseUrl();
  if (isErr(url)) {
    console.error(url.error.message);
    process.exit(1);
  }
  const c = await openPgClient(url.value);
  try {
    const tables = await c.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const indexes = await c.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const matviews = await c.query<{ matviewname: string }>(
      `SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' ORDER BY matviewname`,
    );
    const funcs = await c.query<{ proname: string }>(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' ORDER BY proname`,
    );
    const exts = await c.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname`,
    );

    process.stdout.write('# Schema verification\n');
    process.stdout.write(`tables (${tables.rows.length}):\n`);
    for (const r of tables.rows) process.stdout.write(`  - ${r.tablename}\n`);
    process.stdout.write(`indexes: ${indexes.rows[0]?.count ?? '0'}\n`);
    process.stdout.write(`materialized views (${matviews.rows.length}):\n`);
    for (const r of matviews.rows) process.stdout.write(`  - ${r.matviewname}\n`);
    process.stdout.write(`functions (${funcs.rows.length}):\n`);
    for (const r of funcs.rows) process.stdout.write(`  - ${r.proname}\n`);
    process.stdout.write(`extensions (${exts.rows.length}):\n`);
    for (const r of exts.rows) process.stdout.write(`  - ${r.extname}\n`);
  } finally {
    await c.end();
  }
}

void main();
