/**
 * Tier 3 — embedding-based matching. Stub for Phase 4.
 *
 * The architectural slot is reserved so the resolver and any future tuning
 * surface can call into this layer without restructure. Implementing it
 * requires:
 *
 *   - Per-person writing-style embeddings persisted on `person` or a sibling
 *     table (1536-dim, sourced from communications).
 *   - A pgvector cosine-similarity lookup (`<#>` operator).
 *   - The combined-score formula from SPEC.md §4.2 Tier 3 with at least one
 *     supporting heuristic signal required.
 *
 * Spec ref: SPEC.md §4.2 Tier 3.
 */
import { ResolutionError } from '@atlas/core';

import type { PersonWithContext } from './store.js';
import type { NormalizedPersonPayload } from './types.js';

/**
 * Compute the embedding-based confidence for a record-candidate pair.
 * Throws `ResolutionError(NOT_IMPLEMENTED)` until Phase 4 lands.
 *
 * @example
 * ```ts
 * // throws — do not call from Tier 1/2 paths.
 * await resolveTier3(record, candidate);
 * ```
 */
export async function resolveTier3(
  _record: NormalizedPersonPayload,
  _candidate: PersonWithContext,
): Promise<never> {
  throw new ResolutionError(
    'Tier 3 (embedding-based) resolution is not implemented until Phase 4',
    'NOT_IMPLEMENTED',
    { tier: 3 },
  );
}
