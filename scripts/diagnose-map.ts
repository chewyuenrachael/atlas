#!/usr/bin/env node
/**
 * One-shot diagnostic for the cockpit /map zero-data bug.
 * Prints presence of env vars (not values) and DB row counts.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openPgClient, readDatabaseUrl } from '@atlas/db/pg-client';
import { getServiceClient } from '@atlas/db';

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'DATABASE_URL',
  'NEXT_PUBLIC_MAPBOX_TOKEN',
] as const;

function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function envPresence(): void {
  const root = loadDotEnv(resolve(process.cwd(), '.env'));
  const cockpit = loadDotEnv(resolve(process.cwd(), 'apps/cockpit/.env.local'));
  console.log('\n=== 1. ENV VAR PRESENCE ===');
  for (const key of ENV_KEYS) {
    const inRoot = Boolean(process.env[key] || root[key]);
    const inCockpit = Boolean(process.env[key] || cockpit[key]);
    const present = inRoot || inCockpit;
    console.log(
      `  ${key.padEnd(32)} ${present ? 'PRESENT' : 'MISSING'}  (root: ${inRoot ? 'yes' : 'no'}, cockpit: ${inCockpit ? 'yes' : 'no'})`,
    );
  }
}

async function pgChecks(): Promise<void> {
  console.log('\n=== 2–5. DATABASE CHECKS ===');
  const url = readDatabaseUrl();
  if (!url.ok) {
    console.log('  DATABASE_URL not set — skipping psql checks');
    return;
  }
  const client = await openPgClient(url.value);
  try {
    const matviews = await client.query<{ matviewname: string }>(
      `SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' ORDER BY matviewname`,
    );
    console.log('\n  Materialized views:');
    for (const r of matviews.rows) console.log(`    - ${r.matviewname}`);
    const expected = ['mv_city_signal', 'mv_events_with_organizers', 'mv_person_activity_summary'];
    for (const v of expected) {
      if (!matviews.rows.some((r) => r.matviewname === v)) {
        console.log(`    MISSING: ${v}`);
      }
    }

    const counts = [
      'city_coordinates',
      'mv_city_signal',
      'mv_events_with_organizers',
      'mv_person_activity_summary',
      'event',
      'person',
      'person_event',
    ];
    console.log('\n  Row counts:');
    for (const table of counts) {
      try {
        const r = await client.query<{ count: string }>(`SELECT COUNT(*)::TEXT AS count FROM ${table}`);
        console.log(`    ${table.padEnd(32)} ${r.rows[0]?.count ?? '?'}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`    ${table.padEnd(32)} ERROR: ${msg}`);
      }
    }

    const cities = await client.query<{ venue_city: string; venue_country: string | null }>(
      `SELECT DISTINCT venue_city, venue_country FROM event WHERE venue_city IS NOT NULL ORDER BY venue_city`,
    );
    console.log('\n  Event venue cities:');
    for (const r of cities.rows) {
      console.log(`    ${r.venue_city}, ${r.venue_country ?? '(null country)'}`);
    }

    const unseeded = await client.query<{ venue_city: string; venue_country: string | null }>(
      `SELECT DISTINCT e.venue_city, e.venue_country
       FROM event e
       WHERE e.venue_city IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM city_coordinates cc
           WHERE LOWER(cc.city) = LOWER(e.venue_city)
             AND LOWER(cc.country) = LOWER(COALESCE(e.venue_country, ''))
         )
       ORDER BY e.venue_city`,
    );
    console.log('\n  Unseeded event cities (no city_coordinates match):');
    if (unseeded.rows.length === 0) {
      console.log('    (none — all event cities have coordinates)');
    } else {
      for (const r of unseeded.rows) {
        console.log(`    ${r.venue_city}, ${r.venue_country ?? '(null country)'}`);
      }
    }

    const plottableEvents = await client.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM mv_events_with_organizers
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
    );
    const ambassadorCities = await client.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM mv_city_signal
       WHERE ambassador_count > 0 AND latitude IS NOT NULL AND longitude IS NOT NULL`,
    );
    const ambassadors = await client.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM person WHERE lifecycle_stage IN ('ambassador', 'regional_lead')`,
    );
    console.log('\n  Map query simulation (current page.tsx filters):');
    console.log(`    events (onlyWithCoordinates)     ${plottableEvents.rows[0]?.count ?? '?'}`);
    console.log(`    cities (ambassador + coords)     ${ambassadorCities.rows[0]?.count ?? '?'}`);
    console.log(`    persons (ambassador/regional)    ${ambassadors.rows[0]?.count ?? '?'}`);
  } finally {
    await client.end();
  }
}

async function supabaseChecks(): Promise<void> {
  console.log('\n=== SUPABASE POSTGREST CHECKS ===');
  const svc = getServiceClient();
  if (!svc.ok) {
    console.log(`  getServiceClient failed: ${svc.error.message}`);
    return;
  }
  const sb = svc.value;
  for (const view of ['mv_city_signal', 'mv_events_with_organizers']) {
    const r = await sb.from(view).select('id', { count: 'exact', head: true });
    if (r.error) {
      console.log(`  ${view}: ERROR ${r.error.message} (code: ${r.error.code})`);
    } else {
      console.log(`  ${view}: count=${r.count ?? '?'}`);
    }
    const withCoords = await sb
      .from(view)
      .select('*', { count: 'exact', head: true })
      .not('latitude', 'is', null)
      .not('longitude', 'is', null);
    if (withCoords.error) {
      console.log(`  ${view} (with coords): ERROR ${withCoords.error.message}`);
    } else {
      console.log(`  ${view} (with coords): count=${withCoords.count ?? '?'}`);
    }
  }
}

async function main(): Promise<void> {
  envPresence();
  await pgChecks();
  await supabaseChecks();
}

main().catch((e) => {
  console.error('diagnose-map failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
