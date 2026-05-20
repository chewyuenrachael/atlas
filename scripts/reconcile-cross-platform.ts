#!/usr/bin/env node
/**
 * Phase 2D post-ingest reconciliation — link HN and Reddit identities to
 * existing Luma persons via name-slug heuristics.
 *
 * The default resolver runs each new record in isolation against the
 * candidate pool. With Luma (real names) → HN/Reddit (handles) the matching
 * is one-sided: an HN handle "alicechen" has no name to fuzzy-match against
 * Luma's "Alice Chen" because Jaro-Winkler over short tokens is unstable.
 *
 * This script walks the opposite direction: for every Luma person, compute a
 * set of plausible name slugs and look for HN/Reddit persons whose handle
 * matches. When the match is good, call `mergePersons` so the existing Luma
 * person inherits the HN/Reddit `platform_identity` row.
 *
 * Conservative thresholds:
 *   - Exact slug match → auto-merge
 *   - Otherwise, require Jaro-Winkler ≥ 0.95 with the HN handle ≥ 6 chars.
 *
 * SPEC ref: §4.2 Tier 2 (heuristic matching), §4.4 (audit trail).
 */
import { logger } from '@atlas/core';
import { PersonQueries, getServiceClient } from '@atlas/db';
import { jaroWinklerSimilarity } from '@atlas/intelligence-identity-resolution';

interface PersonRow {
  id: string;
  canonical_name: string;
}

interface PlatformIdentityRow {
  person_id: string;
  platform: string;
  handle: string;
}

/** Strip diacritics, lowercase, and remove non-alphanumeric characters. */
function nameToCore(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Generate plausible handle slugs from a full name. Examples for "Alice Chen":
 *   - alicechen        (concatenated)
 *   - alice.chen
 *   - alice_chen
 *   - alicec, achen     (initialled)
 *   - alice            (firstname only)
 */
function generateSlugs(name: string): Set<string> {
  const slugs = new Set<string>();
  const parts = name
    .split(/\s+/)
    .map((p) => p.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((p) => p.length > 0);
  if (parts.length === 0) return slugs;

  const first = parts[0]!;
  const last = parts[parts.length - 1]!;

  // Concatenations
  slugs.add(parts.join(''));
  slugs.add(parts.join('.'));
  slugs.add(parts.join('_'));
  slugs.add(parts.join('-'));

  // Initialled variants
  if (parts.length >= 2) {
    slugs.add(first + last[0]);
    slugs.add(first[0] + last);
  }
  // Reverse
  if (parts.length >= 2) {
    slugs.add(last + first);
  }
  // Single-name (only if 4+ chars to avoid noisy matches like "tom")
  if (first.length >= 5) slugs.add(first);
  if (last.length >= 5) slugs.add(last);

  return slugs;
}

interface MatchCandidate {
  lumaPersonId: string;
  lumaName: string;
  otherPersonId: string;
  platform: string;
  handle: string;
  reason: string;
  confidence: number;
}

async function main(): Promise<void> {
  const log = logger.child({ script: 'reconcile-cross-platform' });
  const svc = getServiceClient();
  if (!svc.ok) {
    log.error({ err: svc.error }, 'no Supabase client');
    process.exit(1);
  }
  const sb = svc.value;

  // 1. Load Luma persons (active, has luma platform identity).
  const lumaIds = await sb
    .from('person_platform_identity')
    .select('person_id, handle')
    .eq('platform', 'luma');
  if (lumaIds.error) throw new Error(lumaIds.error.message);
  const lumaPersonIds = [...new Set((lumaIds.data ?? []).map((r) => (r as { person_id: string }).person_id))];

  const lumaPersons: PersonRow[] = [];
  for (const id of lumaPersonIds) {
    const r = await sb.from('person').select('id, canonical_name, is_active').eq('id', id).maybeSingle();
    if (r.error || !r.data) continue;
    const row = r.data as { id: string; canonical_name: string; is_active: boolean };
    if (!row.is_active) continue;
    lumaPersons.push({ id: row.id, canonical_name: row.canonical_name });
  }
  log.info({ luma_count: lumaPersons.length }, 'loaded luma persons');

  // 2. Load all HN + Reddit identities.
  const others = await sb
    .from('person_platform_identity')
    .select('person_id, platform, handle')
    .in('platform', ['hackernews', 'reddit']);
  if (others.error) throw new Error(others.error.message);
  const otherIdentities = (others.data ?? []) as PlatformIdentityRow[];
  log.info({ other_count: otherIdentities.length }, 'loaded HN + Reddit identities');

  // 3. Build a slug → lumaPersonId map.
  const slugIndex = new Map<string, { personId: string; name: string }[]>();
  for (const p of lumaPersons) {
    const slugs = generateSlugs(p.canonical_name);
    for (const slug of slugs) {
      if (slug.length < 4) continue;
      const bucket = slugIndex.get(slug) ?? [];
      bucket.push({ personId: p.id, name: p.canonical_name });
      slugIndex.set(slug, bucket);
    }
  }

  // 4. Try to match each HN/Reddit identity.
  const candidates: MatchCandidate[] = [];
  for (const ident of otherIdentities) {
    const core = nameToCore(ident.handle);
    if (core.length < 5) continue;
    const direct = slugIndex.get(core);
    if (direct && direct.length === 1) {
      candidates.push({
        lumaPersonId: direct[0]!.personId,
        lumaName: direct[0]!.name,
        otherPersonId: ident.person_id,
        platform: ident.platform,
        handle: ident.handle,
        reason: 'name_slug_exact',
        confidence: 0.92,
      });
      continue;
    }
    // Fuzzy: compare to every luma name core and accept if Jaro-Winkler ≥ 0.95
    // with a length ≥ 6 (avoids 4-char collisions).
    if (core.length < 6) continue;
    let best: { personId: string; name: string; sim: number } | null = null;
    for (const p of lumaPersons) {
      const luma_core = nameToCore(p.canonical_name);
      if (luma_core.length < 6) continue;
      const sim = jaroWinklerSimilarity(core, luma_core);
      if (sim >= 0.95 && (best === null || sim > best.sim)) {
        best = { personId: p.id, name: p.canonical_name, sim };
      }
    }
    if (best) {
      candidates.push({
        lumaPersonId: best.personId,
        lumaName: best.name,
        otherPersonId: ident.person_id,
        platform: ident.platform,
        handle: ident.handle,
        reason: `name_slug_fuzzy(jw=${best.sim.toFixed(3)})`,
        confidence: Math.min(0.95, 0.85 + (best.sim - 0.95) * 2),
      });
    }
  }

  log.info({ candidates: candidates.length }, 'found cross-platform candidates');

  // 5. Apply merges. mergePersons handles the audit row + soft-delete.
  let merged = 0;
  let skipped = 0;
  let failed = 0;
  const mergedNames: { name: string; platforms: string[] }[] = [];
  for (const c of candidates) {
    if (c.lumaPersonId === c.otherPersonId) {
      skipped += 1;
      continue;
    }
    const result = await PersonQueries.mergePersons(c.otherPersonId, c.lumaPersonId, {
      action: 'merge',
      matchedPersonId: c.lumaPersonId,
      confidence: c.confidence,
      signals: [
        {
          signalType: 'name_fuzzy',
          weight: 1,
          confidence: c.confidence,
        },
      ],
      reasoning: `cross-platform reconciliation: ${c.reason} on handle="${c.handle}" → luma "${c.lumaName}"`,
    });
    if (!result.ok) {
      failed += 1;
      log.warn(
        { err: result.error, source: c.otherPersonId, target: c.lumaPersonId },
        'mergePersons failed',
      );
      continue;
    }
    merged += 1;
    mergedNames.push({ name: c.lumaName, platforms: ['luma', c.platform] });
  }

  log.info({ merged, skipped, failed }, 'reconciliation complete');

  const lines: string[] = [
    '',
    'Cross-platform reconciliation — summary',
    '──────────────────────────────────────',
    `  candidates considered:    ${candidates.length}`,
    `  merges applied:           ${merged}`,
    `  merges skipped (self):    ${skipped}`,
    `  merges failed:            ${failed}`,
    '',
    'Notable cross-platform merges (first 10):',
  ];
  for (const m of mergedNames.slice(0, 10)) {
    lines.push(`  • ${m.name} — ${m.platforms.join(' + ')}`);
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

main().catch((cause: unknown) => {
  logger.error({ err: cause }, 'reconcile-cross-platform failed');
  process.exitCode = 1;
});
