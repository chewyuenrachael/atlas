/**
 * @atlas/intelligence-identity-resolution
 *
 * Tier 1 (explicit linking) + Tier 2 (heuristic matching) identity
 * resolution. Tier 3 (embedding-based) is stubbed for Phase 4.
 *
 * Spec ref: SPEC.md §4.
 *
 * @example
 * ```ts
 * import { IdentityResolver, InMemoryPersonStore } from '@atlas/intelligence-identity-resolution';
 *
 * const store = new InMemoryPersonStore();
 * const resolver = new IdentityResolver({ store, audit: store });
 * const result = await resolver.resolve(record);
 * ```
 */
export { IdentityResolver } from './resolver.js';
export type { IdentityResolverDeps } from './resolver.js';

export { computeMatchConfidence } from './scoring.js';
export { decideAction } from './decision.js';
export { findCandidates } from './candidates.js';
export { detectConflict } from './conflicts.js';

export {
  extractAllSignals,
  extractNameExact,
  extractNameFuzzy,
  extractEmailExact,
  extractEmailDomainWithNameMatch,
  extractGithubLinkInBio,
  extractTwitterLinkInBio,
  extractLinkedinLinkInBio,
  extractEmployerMatch,
  extractCityMatch,
  extractTimezoneOverlap,
  extractMutualConnection,
  extractEventCoAttendance,
} from './signals.js';

export { jaroSimilarity, jaroWinklerSimilarity } from './jaro-winkler.js';
export {
  normalizeName,
  normalizeEmail,
  normalizeHandle,
  emailDomain,
  isFreeMailDomain,
} from './normalize.js';

export {
  writeResolutionDecision,
  enqueueHumanReviewItem,
  type WriteResolutionDecisionArgs,
  type EnqueueHumanReviewArgs,
} from './audit.js';

export {
  InMemoryPersonStore,
  type PersonStore,
  type ResolutionAuditStore,
  type PersonWithContext,
  type NewPersonInput,
  type NewPlatformIdentityInput,
  type PersonMergePatch,
  type HumanReviewQueueItem,
} from './store.js';

export {
  SupabasePersonStore,
  SupabaseResolutionAuditStore,
  findEventIdByLumaId,
} from './store-supabase.js';

export type {
  NormalizedPersonPayload,
  NormalizedPersonRecord,
  ResolutionOutcome,
  ResolutionCandidateView,
  ScoredCandidate,
} from './types.js';

export { resolveTier3 } from './tier3.js';
