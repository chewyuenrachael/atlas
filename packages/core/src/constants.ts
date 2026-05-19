/**
 * Atlas-wide tunable constants.
 *
 * Every threshold, weight, and decay period referenced by SPEC.md §4 lives
 * here so that intelligence services and adapters never hard-code magic
 * numbers in their bodies. Anything tunable that affects identity resolution
 * or scoring belongs in this file.
 */

import type { ResolutionSignalType, RateLimitConfig } from './types.js';

// ---------------------------------------------------------------------------
// Identity resolution thresholds (SPEC.md §4.2 — Tier 2 Heuristic Matching).
// ---------------------------------------------------------------------------

/** Confidence at or above which the resolver auto-merges with no human review. */
export const RESOLUTION_AUTO_MERGE_THRESHOLD = 0.85;

/** Confidence at or above which the resolver enqueues for human review. */
export const RESOLUTION_HUMAN_REVIEW_THRESHOLD = 0.65;

/** Below this confidence: log as candidate, do not merge. */
export const RESOLUTION_NO_MERGE_CEILING = 0.65;

/** Maximum corroboration boost applied in `computeMatchConfidence`. */
export const RESOLUTION_CORROBORATION_BOOST_MAX = 0.15;

/** Per-distinct-signal contribution to corroboration boost. */
export const RESOLUTION_CORROBORATION_BOOST_PER_SIGNAL = 0.03;

/** Minimum cosine similarity for Tier 3 embedding-based matching. */
export const RESOLUTION_EMBEDDING_MIN_COSINE = 0.85;

/** Cosine similarity at which embeddings alone become near-conclusive. */
export const RESOLUTION_EMBEDDING_STRONG_COSINE = 0.92;

/** Jaro-Winkler threshold above which a name is considered a "fuzzy" match. */
export const RESOLUTION_NAME_FUZZY_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Heuristic signal weights (SPEC.md §4.2 table).
// ---------------------------------------------------------------------------

/**
 * Weight per signal type. Used by `computeMatchConfidence(signals)`.
 * Values are between 0 and 1.
 */
export const RESOLUTION_SIGNAL_WEIGHTS: Readonly<Record<ResolutionSignalType, number>> = {
  name_exact: 0.4,
  name_fuzzy: 0.2,
  email_exact: 0.95,
  email_domain: 0.6,
  employer_match: 0.3,
  city_match: 0.2,
  timezone_overlap: 0.1,
  github_link_in_bio: 0.85,
  twitter_link_in_bio: 0.85,
  linkedin_link_in_bio: 0.85,
  mutual_connection: 0.25,
  event_co_attendance: 0.15,
};

// ---------------------------------------------------------------------------
// Lifecycle / decay (SPEC.md §3.2.1, §3.2.7).
// ---------------------------------------------------------------------------

/** Person is marked inactive after this many days with no observation. */
export const PERSON_INACTIVITY_DAYS = 180;

/** Default signal decay window (days). Some signal types override this. */
export const SIGNAL_DEFAULT_DECAY_DAYS = 90;

/** Decay windows per signal type. Missing entries use the default. */
export const SIGNAL_DECAY_DAYS: Readonly<Record<string, number>> = {
  event_attended: 365,
  event_hosted: 730,
  positive_sentiment: 90,
  negative_sentiment: 180,
  product_usage_spike: 30,
  churn_risk_indicator: 60,
  enterprise_advocacy: 180,
};

// ---------------------------------------------------------------------------
// Query and workflow limits (SPEC.md §7.3, §7.4).
// ---------------------------------------------------------------------------

/** Ask Anything generated query timeout. */
export const ASK_ANYTHING_QUERY_TIMEOUT_MS = 10_000;

/** Ask Anything result row cap. */
export const ASK_ANYTHING_MAX_ROWS = 1_000;

/** Ask Anything LLM retry budget for invalid SQL. */
export const ASK_ANYTHING_MAX_RETRIES = 3;

/** Ask Anything response cache TTL. */
export const ASK_ANYTHING_CACHE_TTL_SECONDS = 300;

/** Inngest retry settings (SPEC.md §5.4). */
export const INNGEST_MAX_RETRIES = 5;
export const INNGEST_MAX_BACKOFF_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rate limits (SPEC.md §5.2 per-source specs). Adapters import these.
// ---------------------------------------------------------------------------

export const RATE_LIMIT_LUMA: RateLimitConfig = {
  maxRequestsPerInterval: 60,
  intervalMs: 60 * 1000,
};

export const RATE_LIMIT_GITHUB: RateLimitConfig = {
  maxRequestsPerInterval: 5000,
  intervalMs: 60 * 60 * 1000,
};

export const RATE_LIMIT_REDDIT: RateLimitConfig = {
  maxRequestsPerInterval: 60,
  intervalMs: 60 * 1000,
};

export const RATE_LIMIT_HACKERNEWS: RateLimitConfig = {
  maxRequestsPerInterval: 600,
  intervalMs: 60 * 1000,
};

export const RATE_LIMIT_YOUTUBE_QUOTA_PER_DAY = 10_000;
export const RATE_LIMIT_YOUTUBE_SEARCH_COST = 100;

/** Default rate limit when nothing source-specific is configured. */
export const RATE_LIMIT_DEFAULT: RateLimitConfig = {
  maxRequestsPerInterval: 30,
  intervalMs: 60 * 1000,
};

// ---------------------------------------------------------------------------
// Performance targets (SPEC.md §7.4). Wired into observability assertions.
// ---------------------------------------------------------------------------

export const PERF_TARGET_PERSON_LOOKUP_P99_MS = 5;
export const PERF_TARGET_PERSON_SEARCH_P99_MS = 50;
export const PERF_TARGET_ONE_HOP_P99_MS = 100;
export const PERF_TARGET_TWO_HOP_P99_MS = 500;
export const PERF_TARGET_THREE_HOP_P99_MS = 2_000;
export const PERF_TARGET_MV_QUERY_P99_MS = 100;
export const PERF_TARGET_ASK_ANYTHING_P99_MS = 6_000;
