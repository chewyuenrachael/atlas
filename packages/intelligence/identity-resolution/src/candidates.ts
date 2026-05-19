/**
 * Candidate lookup — pick up to N existing Persons that *might* match the
 * incoming normalized record.
 *
 * Priority order (highest signal first):
 *   1. Exact email match (one candidate per email)
 *   2. Exact platform handle match on the record's platform identity
 *   3. Exact platform handle match on any bio-link platform (github, twitter,
 *      linkedin)
 *   4. Fuzzy name match (Jaro–Winkler ≥ 0.8, via the trigram-index proxy in
 *      `PersonStore.findByNameTrigram`) intersected with city / employer
 *      agreement when those facts are present on the record.
 *
 * The function returns at most `limit` candidates deduplicated by personId.
 * Order reflects priority — callers that pass the result to the scorer rely
 * on this order only for the calibration histogram, not for correctness;
 * the scorer evaluates every candidate independently.
 *
 * Spec ref: SPEC.md §4.3.
 */
import type { PlatformIdentityPlatform, UUID } from '@atlas/core';

import { normalizeName } from './normalize.js';
import type { PersonStore, PersonWithContext } from './store.js';
import type { NormalizedPersonPayload } from './types.js';

const DEFAULT_CANDIDATE_LIMIT = 20;
const TRIGRAM_FETCH_OVERFETCH = 4;

/**
 * Return up to `limit` candidate `PersonWithContext` rows the resolver should
 * score.
 *
 * @example
 * ```ts
 * const candidates = await findCandidates(record, store, 20);
 * ```
 */
export async function findCandidates(
  record: NormalizedPersonPayload,
  store: PersonStore,
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): Promise<PersonWithContext[]> {
  const seen = new Set<UUID>();
  const out: PersonWithContext[] = [];

  const push = (candidate: PersonWithContext | null): void => {
    if (!candidate) return;
    if (seen.has(candidate.person.id)) return;
    if (out.length >= limit) return;
    seen.add(candidate.person.id);
    out.push(candidate);
  };

  // 1. Email matches
  const emails = new Set<string>();
  if (record.primaryEmail) emails.add(record.primaryEmail);
  for (const e of record.emails ?? []) emails.add(e);
  for (const email of emails) {
    if (out.length >= limit) break;
    push(await store.findByEmail(email));
  }

  // 2. Same-platform handle
  if (record.platformIdentity && out.length < limit) {
    push(
      await store.findByPlatformHandle(
        record.platformIdentity.platform,
        record.platformIdentity.handle,
      ),
    );
  }

  // 3. Bio-link handles
  const bioLinks: Array<[PlatformIdentityPlatform, string | undefined]> = [
    ['github', record.bioLinks?.github],
    ['twitter', record.bioLinks?.twitter],
    ['linkedin', record.bioLinks?.linkedin],
  ];
  for (const [platform, handle] of bioLinks) {
    if (out.length >= limit) break;
    if (!handle) continue;
    push(await store.findByPlatformHandle(platform, handle));
  }

  // 4. Fuzzy name match, narrowed by city / employer when available.
  if (record.canonicalName && out.length < limit) {
    const remaining = limit - out.length;
    const nameMatches = await store.findByNameTrigram(
      record.canonicalName,
      remaining * TRIGRAM_FETCH_OVERFETCH,
    );
    const recordCity = normalizeName(record.city);
    const recordEmployer = record.employerCompanyId;
    for (const candidate of nameMatches) {
      if (out.length >= limit) break;
      const candidateCity = normalizeName(candidate.person.location_city);
      const cityAgree = !!recordCity && !!candidateCity && recordCity === candidateCity;
      const employerAgree =
        !!recordEmployer &&
        !!candidate.currentEmployerCompanyId &&
        recordEmployer === candidate.currentEmployerCompanyId;
      // When the record carries neither city nor employer, fall back to
      // accepting the name match alone (rare in practice; common in tests).
      const hasContext = !!recordCity || !!recordEmployer;
      if (hasContext && !cityAgree && !employerAgree) continue;
      push(candidate);
    }
  }

  return out;
}
