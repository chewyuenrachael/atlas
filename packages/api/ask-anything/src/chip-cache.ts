/**
 * Process-local cache of chip query results.
 *
 * The Atlas data is updated by backfills (manual / scheduled), not by user
 * activity, so a TTL of 5 minutes is generous. Cache miss → re-run the SQL.
 *
 * This module is intentionally Node-only — `getServiceClient()` reads
 * `SUPABASE_*` env vars. Called from Next.js route handlers under the
 * Node runtime (NOT Edge).
 */
import { findChipById, type ChipDef } from './chips.js';
import { runSelect, type QueryRunResult } from './executor.js';

interface CacheEntry {
  result: QueryRunResult;
  cachedAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export interface RunChipResult {
  chip: ChipDef;
  result: QueryRunResult;
  cached: boolean;
}

/**
 * Run a chip by id. Returns the cached row data if it's still fresh,
 * otherwise re-executes the SQL and replaces the cache entry.
 *
 * Cache lookups are O(1); the only async cost on a cache hit is JSON
 * serialization by the framework.
 */
export async function runChip(chipId: string): Promise<RunChipResult | null> {
  const chip = findChipById(chipId);
  if (!chip) return null;

  const now = Date.now();
  const cached = cache.get(chipId);
  if (cached && now - cached.cachedAt < TTL_MS) {
    return { chip, result: cached.result, cached: true };
  }

  const result = await runSelect(chip.sql);
  if (result.ok) {
    cache.set(chipId, { result, cachedAt: now });
  }
  return { chip, result, cached: false };
}

/** Test seam: drop the cache (used by smoke tests). */
export function clearChipCache(): void {
  cache.clear();
}
