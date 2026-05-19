/**
 * Signal extractors — Tier 2 heuristic matching.
 *
 * Each function in this file inspects a normalized record against an existing
 * candidate Person (plus its auxiliary context) and emits one or more
 * `ResolutionSignal`s. Weights come from `RESOLUTION_SIGNAL_WEIGHTS` in
 * `@atlas/core/constants`, never hard-coded here.
 *
 * Spec ref: SPEC.md §4.2 (signal table + Tier 2 thresholds).
 */
import {
  RESOLUTION_NAME_FUZZY_THRESHOLD,
  RESOLUTION_SIGNAL_WEIGHTS,
  type PlatformIdentityPlatform,
  type ResolutionSignal,
  type ResolutionSignalType,
} from '@atlas/core';

import { jaroWinklerSimilarity } from './jaro-winkler.js';
import {
  emailDomain,
  isFreeMailDomain,
  normalizeEmail,
  normalizeHandle,
  normalizeName,
} from './normalize.js';
import type { PersonWithContext } from './store.js';
import type { NormalizedPersonPayload } from './types.js';

/** Internal helper: build a signal with the canonical weight from constants. */
function signal(signalType: ResolutionSignalType, confidence: number): ResolutionSignal {
  return {
    signalType,
    weight: RESOLUTION_SIGNAL_WEIGHTS[signalType],
    confidence: clamp01(confidence),
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n) || n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// Name signals
// ---------------------------------------------------------------------------

/**
 * `name_exact` — direct equality of any name observation on either side
 * after `normalizeName`.
 */
export function extractNameExact(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal | null {
  const candidateNames = collectCandidateNames(candidate);
  const recordNames = collectRecordNames(record);
  if (candidateNames.size === 0 || recordNames.size === 0) return null;
  for (const n of recordNames) {
    if (candidateNames.has(n)) return signal('name_exact', 1);
  }
  return null;
}

/**
 * `name_fuzzy` — best Jaro–Winkler similarity above the threshold across all
 * (record name × candidate name) pairs. Confidence is scaled from the
 * threshold up to 1 so a borderline 0.86 contributes less than a 0.99 match.
 */
export function extractNameFuzzy(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal | null {
  const recordNames = Array.from(collectRecordNames(record));
  const candidateNames = Array.from(collectCandidateNames(candidate));
  if (recordNames.length === 0 || candidateNames.length === 0) return null;
  // Skip if we already had an exact match — emitting both would double-count.
  if (recordNames.some((n) => candidateNames.includes(n))) return null;

  let bestScore = 0;
  for (const rn of recordNames) {
    for (const cn of candidateNames) {
      const score = jaroWinklerSimilarity(rn, cn);
      if (score > bestScore) bestScore = score;
    }
  }
  if (bestScore < RESOLUTION_NAME_FUZZY_THRESHOLD) return null;
  const confidence =
    (bestScore - RESOLUTION_NAME_FUZZY_THRESHOLD) / (1 - RESOLUTION_NAME_FUZZY_THRESHOLD);
  // A bare 0.85 match should still register; floor to 0.5 so it isn't 0.
  return signal('name_fuzzy', Math.max(0.5, confidence));
}

// ---------------------------------------------------------------------------
// Email signals
// ---------------------------------------------------------------------------

/** `email_exact` — any record email matches any candidate email exactly. */
export function extractEmailExact(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal | null {
  const recordEmails = collectRecordEmails(record);
  const candidateEmails = collectCandidateEmails(candidate);
  if (recordEmails.size === 0 || candidateEmails.size === 0) return null;
  for (const e of recordEmails) {
    if (candidateEmails.has(e)) return signal('email_exact', 1);
  }
  return null;
}

/**
 * `email_domain` — same non-free email domain AND a name signal corroborates.
 *
 * The SPEC table treats "email_domain match + name match" as a single
 * heuristic (weight 0.6). We only emit this signal when both conditions hold
 * so the corroboration is implicit. Free-mail providers (gmail, hotmail, …)
 * are excluded — sharing those domains is meaningless.
 */
export function extractEmailDomainWithNameMatch(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal | null {
  const sharedDomain = findSharedNonFreeDomain(record, candidate);
  if (!sharedDomain) return null;
  // Require some name agreement — exact or fuzzy.
  const nameSignal = extractNameExact(record, candidate) ?? extractNameFuzzy(record, candidate);
  if (!nameSignal) return null;
  return signal('email_domain', nameSignal.confidence);
}

// ---------------------------------------------------------------------------
// Bio-link signals (github / twitter / linkedin)
// ---------------------------------------------------------------------------

/**
 * `<platform>_link_in_bio` — a handle the new record references in its bio
 * matches an existing `person_platform_identity` for the candidate on the
 * same platform. Generic across platforms; bound at call sites below.
 */
function extractBioLink(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
  platform: 'github' | 'twitter' | 'linkedin',
): ResolutionSignal | null {
  const recordHandle = normalizeHandle(record.bioLinks?.[platform]);
  if (!recordHandle) return null;
  // Also count if the record *is* itself a platform identity for that
  // platform — e.g. a GitHub adapter emitting a record with platformIdentity
  // on github counts as a github link for matching purposes.
  const candidateHandles = candidate.platformIdentities
    .filter((id) => id.platform === platform)
    .map((id) => normalizeHandle(id.handle));
  if (candidateHandles.length === 0) return null;
  if (!candidateHandles.includes(recordHandle)) return null;
  const signalType: ResolutionSignalType =
    platform === 'github'
      ? 'github_link_in_bio'
      : platform === 'twitter'
        ? 'twitter_link_in_bio'
        : 'linkedin_link_in_bio';
  return signal(signalType, 1);
}

export const extractGithubLinkInBio = (
  r: NormalizedPersonPayload,
  c: PersonWithContext,
): ResolutionSignal | null => extractBioLink(r, c, 'github');

export const extractTwitterLinkInBio = (
  r: NormalizedPersonPayload,
  c: PersonWithContext,
): ResolutionSignal | null => extractBioLink(r, c, 'twitter');

export const extractLinkedinLinkInBio = (
  r: NormalizedPersonPayload,
  c: PersonWithContext,
): ResolutionSignal | null => extractBioLink(r, c, 'linkedin');

// ---------------------------------------------------------------------------
// Context signals (employer, city, timezone, mutual conn, event co-attend.)
// ---------------------------------------------------------------------------

/** `employer_match` — same resolved Company id. */
export function extractEmployerMatch(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal | null {
  if (!record.employerCompanyId || !candidate.currentEmployerCompanyId) return null;
  if (record.employerCompanyId !== candidate.currentEmployerCompanyId) return null;
  return signal('employer_match', 1);
}

/** `city_match` — same `location_city` (case-insensitive). */
export function extractCityMatch(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal | null {
  const a = normalizeName(record.city);
  const b = normalizeName(candidate.person.location_city);
  if (!a || !b || a !== b) return null;
  // If countries are both present and disagree, suppress (same-named city,
  // different country) to avoid Springfield-style false positives.
  if (record.country && candidate.person.location_country) {
    if (normalizeName(record.country) !== normalizeName(candidate.person.location_country)) {
      return null;
    }
  }
  return signal('city_match', 1);
}

/** `timezone_overlap` — identical or overlapping timezone. */
export function extractTimezoneOverlap(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal | null {
  const a = record.timezone?.trim();
  const b = candidate.person.location_timezone?.trim();
  if (!a || !b) return null;
  if (a === b) return signal('timezone_overlap', 1);
  // Postel-style overlap: matching IANA region prefix counts as partial
  // overlap (e.g. America/Los_Angeles vs America/Vancouver share the
  // continent and likely UTC offset).
  const [aRegion] = a.split('/');
  const [bRegion] = b.split('/');
  if (aRegion && bRegion && aRegion === bRegion) {
    return signal('timezone_overlap', 0.5);
  }
  return null;
}

/**
 * `mutual_connection` — any shared person_person_edge. If the new record
 * carries no `connectedPersonIds` we skip rather than emitting a 0-weight
 * signal (a 0-weight signal still consumes a distinct-signal slot and would
 * inflate the corroboration boost without justification).
 */
export function extractMutualConnection(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal | null {
  const conns = record.connectedPersonIds;
  if (!conns || conns.length === 0) return null;
  const candidateConns = new Set(candidate.connectedPersonIds);
  if (candidateConns.size === 0) return null;
  const shared = conns.filter((id) => candidateConns.has(id));
  if (shared.length === 0) return null;
  // Confidence scales gently with overlap, capped at 1.
  const confidence = Math.min(1, shared.length / 3);
  return signal('mutual_connection', Math.max(0.5, confidence));
}

/** `event_co_attendance` — record and candidate share any Event id. */
export function extractEventCoAttendance(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal | null {
  const events = record.eventIds;
  if (!events || events.length === 0) return null;
  const candidateEvents = new Set(candidate.eventIds);
  if (candidateEvents.size === 0) return null;
  const shared = events.filter((id) => candidateEvents.has(id));
  if (shared.length === 0) return null;
  return signal('event_co_attendance', Math.min(1, shared.length / 2));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Run every Tier 2 extractor and collect the non-null signals.
 *
 * @example
 * ```ts
 * const signals = extractAllSignals(payload, candidateContext);
 * const confidence = computeMatchConfidence(signals);
 * ```
 */
export function extractAllSignals(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): ResolutionSignal[] {
  const extractors: Array<
    (r: NormalizedPersonPayload, c: PersonWithContext) => ResolutionSignal | null
  > = [
    extractEmailExact,
    extractNameExact,
    extractNameFuzzy,
    extractEmailDomainWithNameMatch,
    extractGithubLinkInBio,
    extractTwitterLinkInBio,
    extractLinkedinLinkInBio,
    extractEmployerMatch,
    extractCityMatch,
    extractTimezoneOverlap,
    extractMutualConnection,
    extractEventCoAttendance,
  ];
  const signals: ResolutionSignal[] = [];
  for (const fn of extractors) {
    const s = fn(record, candidate);
    if (s) signals.push(s);
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Shared collectors
// ---------------------------------------------------------------------------

function collectRecordNames(record: NormalizedPersonPayload): Set<string> {
  const names = new Set<string>();
  if (record.canonicalName) {
    const n = normalizeName(record.canonicalName);
    if (n) names.add(n);
  }
  for (const n of record.namesSeen ?? []) {
    const normalized = normalizeName(n);
    if (normalized) names.add(normalized);
  }
  return names;
}

function collectCandidateNames(candidate: PersonWithContext): Set<string> {
  const names = new Set<string>();
  const canonical = normalizeName(candidate.person.canonical_name);
  if (canonical) names.add(canonical);
  for (const n of candidate.person.names_seen) {
    const normalized = normalizeName(n);
    if (normalized) names.add(normalized);
  }
  return names;
}

function collectRecordEmails(record: NormalizedPersonPayload): Set<string> {
  const emails = new Set<string>();
  if (record.primaryEmail) {
    const e = normalizeEmail(record.primaryEmail);
    if (e) emails.add(e);
  }
  for (const e of record.emails ?? []) {
    const normalized = normalizeEmail(e);
    if (normalized) emails.add(normalized);
  }
  return emails;
}

function collectCandidateEmails(candidate: PersonWithContext): Set<string> {
  const emails = new Set<string>();
  if (candidate.person.primary_email) {
    const e = normalizeEmail(candidate.person.primary_email);
    if (e) emails.add(e);
  }
  for (const e of candidate.person.emails_seen) {
    const normalized = normalizeEmail(e);
    if (normalized) emails.add(normalized);
  }
  return emails;
}

function findSharedNonFreeDomain(
  record: NormalizedPersonPayload,
  candidate: PersonWithContext,
): string | null {
  const recordDomains = new Set<string>();
  for (const e of collectRecordEmails(record)) {
    const d = emailDomain(e);
    if (d && !isFreeMailDomain(d)) recordDomains.add(d);
  }
  if (recordDomains.size === 0) return null;
  for (const e of collectCandidateEmails(candidate)) {
    const d = emailDomain(e);
    if (d && recordDomains.has(d)) return d;
  }
  return null;
}

/** Re-export for callers that want the raw platform set the resolver scores. */
export const BIO_LINK_PLATFORMS = [
  'github',
  'twitter',
  'linkedin',
] as const satisfies ReadonlyArray<PlatformIdentityPlatform>;
