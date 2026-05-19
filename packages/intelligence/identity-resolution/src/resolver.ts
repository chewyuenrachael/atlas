/**
 * IdentityResolver — entry point for Tier 1 + Tier 2 identity resolution.
 *
 * Each new `NormalizedRecord` of `recordType: 'person'` flows through
 * `resolve(record)`. The resolver:
 *
 *   1. Tier 1 — explicit linking: if the record carries an exact email or
 *      an exact platform handle that matches an existing Person, treat as
 *      ground truth (confidence 1.0) and merge.
 *   2. Tier 2 — heuristic matching: look up candidates, score each with
 *      `extractAllSignals` + `computeMatchConfidence`, choose the top.
 *   3. Decision — based on the top confidence + candidate count, pick
 *      `merge` / `create_new` / `human_review` / `skip`.
 *   4. Persistence — write the Person rows, platform identity rows, and
 *      audit row through the provided stores.
 *
 * Spec ref: SPEC.md §4.2 (tiers + thresholds), §4.3 (workflow), §4.4 (audit).
 */
import {
  ResolutionError,
  err,
  isErr,
  ok,
  tryAsync,
  type AtlasError,
  type IsoTimestamp,
  type Metadata,
  type NormalizedRecord,
  type ResolutionSignal,
  type Result,
  logger as rootLogger,
} from '@atlas/core';

import { findCandidates } from './candidates.js';
import { detectConflict } from './conflicts.js';
import { decideAction } from './decision.js';
import { enqueueHumanReviewItem, writeResolutionDecision } from './audit.js';
import { computeMatchConfidence } from './scoring.js';
import { extractAllSignals } from './signals.js';
import type {
  NewPersonInput,
  PersonStore,
  PersonWithContext,
  ResolutionAuditStore,
} from './store.js';
import type {
  NormalizedPersonPayload,
  NormalizedPersonRecord,
  ResolutionCandidateView,
  ResolutionOutcome,
  ScoredCandidate,
} from './types.js';

/** Dependencies injected into the resolver. */
export interface IdentityResolverDeps {
  store: PersonStore;
  audit: ResolutionAuditStore;
  /** Pino logger (or compatible). Defaults to the root logger. */
  logger?: typeof rootLogger;
  /** Override the candidate fetch cap. Defaults to 20. */
  candidateLimit?: number;
}

/**
 * The Tier 1 + Tier 2 resolver. Stateless aside from its deps.
 *
 * @example
 * ```ts
 * const store = new InMemoryPersonStore();
 * const resolver = new IdentityResolver({ store, audit: store });
 * const result = await resolver.resolve(record);
 * if (result.ok) console.log(result.value.action, result.value.personId);
 * ```
 */
export class IdentityResolver {
  private readonly store: PersonStore;
  private readonly audit: ResolutionAuditStore;
  private readonly log: typeof rootLogger;
  private readonly candidateLimit: number;

  constructor(deps: IdentityResolverDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.log = deps.logger ?? rootLogger;
    this.candidateLimit = deps.candidateLimit ?? 20;
  }

  /**
   * Resolve one normalized person record. Writes a `resolution_decision`
   * row on every code path (no orphan resolutions).
   */
  async resolve(record: NormalizedRecord): Promise<Result<ResolutionOutcome, AtlasError>> {
    if (record.recordType !== 'person') {
      return err(
        new ResolutionError(
          `resolver only accepts recordType 'person', got '${record.recordType}'`,
          'RESOLUTION_INTERNAL_ERROR',
          { recordType: record.recordType, sourcePlatform: record.sourcePlatform },
        ),
      );
    }

    const payload = record.payload as NormalizedPersonPayload;
    const log = this.log.child({
      service: 'identity-resolver',
      candidate_record_source: record.sourcePlatform,
      candidate_record_id: record.sourceRecordId,
    });

    const wrapped = await tryAsync(
      () => this.runResolve(record as NormalizedPersonRecord, payload),
      (cause) =>
        new ResolutionError(
          'resolver crashed',
          'RESOLUTION_INTERNAL_ERROR',
          {
            source: record.sourcePlatform,
            sourceRecordId: record.sourceRecordId,
          },
          cause,
        ),
    );
    if (isErr(wrapped)) {
      log.error({ err: wrapped.error }, 'identity resolution failed');
      return wrapped;
    }
    return ok(wrapped.value);
  }

  // ----- internals ------------------------------------------------------

  private async runResolve(
    record: NormalizedPersonRecord,
    payload: NormalizedPersonPayload,
  ): Promise<ResolutionOutcome> {
    // Tier 1: explicit linking by email or by exact platform handle.
    const tier1 = await this.tier1ExplicitLink(payload);
    if (tier1) {
      return this.handleMerge({
        candidate: tier1.candidate,
        record,
        payload,
        signals: tier1.signals,
        confidence: 1.0,
        candidates: [
          {
            personId: tier1.candidate.person.id,
            confidence: 1.0,
            signals: tier1.signals,
          },
        ],
        reasoning: tier1.reasoning,
        resolutionMethod: 'explicit_link',
      });
    }

    // Tier 2: heuristic candidate scoring.
    const candidates = await findCandidates(payload, this.store, this.candidateLimit);
    const scored = this.scoreCandidates(payload, candidates);
    const top = scored[0];

    const candidatesView: ResolutionCandidateView[] = scored.map((s) => ({
      personId: s.personId,
      confidence: s.confidence,
      signals: s.signals,
    }));

    const topConfidence = top?.confidence ?? 0;
    const action = decideAction(topConfidence, scored.length);

    switch (action) {
      case 'merge': {
        if (!top) {
          // Defensive: decideAction shouldn't return merge without a top.
          return this.handleCreateNew({
            record,
            payload,
            candidates: candidatesView,
            reasoning: 'merge requested without top candidate; falling back to create_new',
          });
        }
        const candidate = candidates.find((c) => c.person.id === top.personId);
        if (!candidate) {
          throw new ResolutionError(
            'top candidate vanished between scoring and merge',
            'RESOLUTION_INTERNAL_ERROR',
            { personId: top.personId },
          );
        }
        return this.handleMerge({
          candidate,
          record,
          payload,
          signals: top.signals,
          confidence: top.confidence,
          candidates: candidatesView,
          reasoning: describeMerge(top.signals, top.confidence),
          resolutionMethod: 'heuristic_match',
        });
      }
      case 'human_review':
        return this.handleHumanReview({
          record,
          payload,
          candidates: candidatesView,
          confidence: topConfidence,
          signals: top?.signals ?? [],
        });
      case 'create_new':
        return this.handleCreateNew({
          record,
          payload,
          candidates: candidatesView,
          reasoning: 'no candidates above threshold; created new Person',
        });
      case 'skip':
        return this.handleSkip({
          record,
          payload,
          candidates: candidatesView,
          confidence: topConfidence,
          signals: top?.signals ?? [],
        });
      default: {
        const _exhaustive: never = action;
        throw new ResolutionError(
          `unhandled resolution action: ${String(_exhaustive)}`,
          'RESOLUTION_INTERNAL_ERROR',
          {},
        );
      }
    }
  }

  private async tier1ExplicitLink(payload: NormalizedPersonPayload): Promise<{
    candidate: PersonWithContext;
    signals: ResolutionSignal[];
    reasoning: string;
  } | null> {
    // Email is the canonical explicit link.
    const emails = new Set<string>();
    if (payload.primaryEmail) emails.add(payload.primaryEmail);
    for (const e of payload.emails ?? []) emails.add(e);
    for (const email of emails) {
      const match = await this.store.findByEmail(email);
      if (match) {
        return {
          candidate: match,
          signals: [{ signalType: 'email_exact', weight: 0.95, confidence: 1 }],
          reasoning: `tier1: email_exact (${email})`,
        };
      }
    }

    // Same-platform handle exact match also counts as explicit linking — the
    // user authenticated against that platform, and the (platform, handle)
    // pair is unique.
    if (payload.platformIdentity) {
      const match = await this.store.findByPlatformHandle(
        payload.platformIdentity.platform,
        payload.platformIdentity.handle,
      );
      if (match) {
        return {
          candidate: match,
          signals: [
            {
              signalType: platformBioSignalType(payload.platformIdentity.platform),
              weight: 0.85,
              confidence: 1,
            },
          ],
          reasoning: `tier1: platform_handle_exact (${payload.platformIdentity.platform}:${payload.platformIdentity.handle})`,
        };
      }
    }
    return null;
  }

  private scoreCandidates(
    payload: NormalizedPersonPayload,
    candidates: PersonWithContext[],
  ): ScoredCandidate[] {
    const scored: ScoredCandidate[] = [];
    for (const candidate of candidates) {
      const signals = extractAllSignals(payload, candidate);
      if (signals.length === 0) continue;
      const confidence = computeMatchConfidence(signals);
      scored.push({ personId: candidate.person.id, signals, confidence });
    }
    scored.sort((a, b) => b.confidence - a.confidence);
    return scored;
  }

  private async handleMerge(args: {
    candidate: PersonWithContext;
    record: NormalizedPersonRecord;
    payload: NormalizedPersonPayload;
    signals: ResolutionSignal[];
    confidence: number;
    candidates: ResolutionCandidateView[];
    reasoning: string;
    resolutionMethod: 'explicit_link' | 'heuristic_match';
  }): Promise<ResolutionOutcome> {
    const { candidate, record, payload } = args;
    const now: IsoTimestamp = record.observedAt;

    const conflictDetected = await detectConflict(
      candidate.person.id,
      payload,
      this.store,
      this.audit,
    );

    await this.store.updatePerson(candidate.person.id, {
      addNamesSeen: collectNamePatch(payload),
      addEmailsSeen: collectEmailPatch(payload),
      primaryEmail: candidate.person.primary_email ?? payload.primaryEmail ?? null,
      city: candidate.person.location_city ?? payload.city ?? null,
      country: candidate.person.location_country ?? payload.country ?? null,
      timezone: candidate.person.location_timezone ?? payload.timezone ?? null,
      lastObservedAt: now,
    });

    if (payload.platformIdentity) {
      await this.store.insertPlatformIdentity({
        personId: candidate.person.id,
        platform: payload.platformIdentity.platform,
        handle: payload.platformIdentity.handle,
        platformUserId: payload.platformIdentity.platformUserId ?? null,
        profileUrl: payload.platformIdentity.profileUrl ?? null,
        followerCount: payload.platformIdentity.followerCount ?? null,
        verified: payload.platformIdentity.verified ?? false,
        observedAt: now,
        resolutionConfidence: round2(args.confidence),
        resolutionMethod: args.resolutionMethod,
      });
    }

    const decisionId = await writeResolutionDecision(this.audit, {
      action: 'merge',
      candidateRecordSource: record.sourcePlatform,
      candidateRecordId: record.sourceRecordId,
      matchedPersonId: candidate.person.id,
      confidence: args.confidence,
      signals: args.signals,
      reasoning: args.reasoning,
      decidedAt: now,
    });

    return {
      action: 'merge',
      personId: candidate.person.id,
      confidence: args.confidence,
      signals: args.signals,
      reasoning: args.reasoning,
      candidates: args.candidates,
      resolutionDecisionId: decisionId,
      conflictDetected,
    };
  }

  private async handleCreateNew(args: {
    record: NormalizedPersonRecord;
    payload: NormalizedPersonPayload;
    candidates: ResolutionCandidateView[];
    reasoning: string;
  }): Promise<ResolutionOutcome> {
    const { record, payload } = args;
    const now: IsoTimestamp = record.observedAt;

    const canonicalName =
      payload.canonicalName?.trim() ||
      payload.namesSeen?.[0]?.trim() ||
      payload.platformIdentity?.handle ||
      payload.primaryEmail ||
      'unknown';

    const input: NewPersonInput = {
      canonicalName,
      namesSeen: collectNamePatch(payload),
      emailsSeen: collectEmailPatch(payload),
      primaryEmail: payload.primaryEmail ?? null,
      locationCity: payload.city ?? null,
      locationCountry: payload.country ?? null,
      locationTimezone: payload.timezone ?? null,
      firstObservedAt: now,
      lastObservedAt: now,
      metadata: (payload.metadata as Metadata | undefined) ?? {},
    };

    const personId = await this.store.insertPerson(input);

    if (payload.platformIdentity) {
      await this.store.insertPlatformIdentity({
        personId,
        platform: payload.platformIdentity.platform,
        handle: payload.platformIdentity.handle,
        platformUserId: payload.platformIdentity.platformUserId ?? null,
        profileUrl: payload.platformIdentity.profileUrl ?? null,
        followerCount: payload.platformIdentity.followerCount ?? null,
        verified: payload.platformIdentity.verified ?? false,
        observedAt: now,
        resolutionConfidence: 1.0,
        resolutionMethod: 'self_reported',
      });
    }

    const decisionId = await writeResolutionDecision(this.audit, {
      action: 'create_new',
      candidateRecordSource: record.sourcePlatform,
      candidateRecordId: record.sourceRecordId,
      matchedPersonId: personId,
      confidence: 0,
      signals: [],
      reasoning: args.reasoning,
      decidedAt: now,
    });

    return {
      action: 'create_new',
      personId,
      confidence: 0,
      signals: [],
      reasoning: args.reasoning,
      candidates: args.candidates,
      resolutionDecisionId: decisionId,
      conflictDetected: false,
    };
  }

  private async handleHumanReview(args: {
    record: NormalizedPersonRecord;
    payload: NormalizedPersonPayload;
    candidates: ResolutionCandidateView[];
    confidence: number;
    signals: ResolutionSignal[];
  }): Promise<ResolutionOutcome> {
    const { record, payload } = args;
    const reasoning = `tier2 confidence ${round2(args.confidence)} in [0.65, 0.85); ${args.candidates.length} candidates`;

    await enqueueHumanReviewItem(this.audit, {
      candidateRecordSource: record.sourcePlatform,
      candidateRecordId: record.sourceRecordId,
      candidatePayload: payload as unknown as Metadata,
      action: 'human_review',
      confidence: args.confidence,
      topCandidates: args.candidates,
      enqueuedAt: record.observedAt,
    });

    const decisionId = await writeResolutionDecision(this.audit, {
      action: 'human_review',
      candidateRecordSource: record.sourcePlatform,
      candidateRecordId: record.sourceRecordId,
      matchedPersonId: null,
      confidence: args.confidence,
      signals: args.signals,
      reasoning,
      decidedAt: record.observedAt,
    });

    return {
      action: 'human_review',
      personId: null,
      confidence: args.confidence,
      signals: args.signals,
      reasoning,
      candidates: args.candidates,
      resolutionDecisionId: decisionId,
      conflictDetected: false,
    };
  }

  private async handleSkip(args: {
    record: NormalizedPersonRecord;
    payload: NormalizedPersonPayload;
    candidates: ResolutionCandidateView[];
    confidence: number;
    signals: ResolutionSignal[];
  }): Promise<ResolutionOutcome> {
    const { record, payload } = args;
    const reasoning = `candidates exist (${args.candidates.length}) but confidence ${round2(args.confidence)} is below review threshold`;

    // The task asks us to surface low-confidence candidates rather than
    // silently dropping them. Enqueue with action='skip' so the operator
    // can decide whether this is a new person or a missed merge.
    await enqueueHumanReviewItem(this.audit, {
      candidateRecordSource: record.sourcePlatform,
      candidateRecordId: record.sourceRecordId,
      candidatePayload: payload as unknown as Metadata,
      action: 'skip',
      confidence: args.confidence,
      topCandidates: args.candidates,
      enqueuedAt: record.observedAt,
    });

    const decisionId = await writeResolutionDecision(this.audit, {
      action: 'skip',
      candidateRecordSource: record.sourcePlatform,
      candidateRecordId: record.sourceRecordId,
      matchedPersonId: null,
      confidence: args.confidence,
      signals: args.signals,
      reasoning,
      decidedAt: record.observedAt,
    });

    return {
      action: 'skip',
      personId: null,
      confidence: args.confidence,
      signals: args.signals,
      reasoning,
      candidates: args.candidates,
      resolutionDecisionId: decisionId,
      conflictDetected: false,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function platformBioSignalType(
  platform: NormalizedPersonPayload['platformIdentity'] extends infer T
    ? T extends { platform: infer P }
      ? P
      : never
    : never,
): ResolutionSignal['signalType'] {
  switch (platform) {
    case 'github':
      return 'github_link_in_bio';
    case 'twitter':
      return 'twitter_link_in_bio';
    case 'linkedin':
      return 'linkedin_link_in_bio';
    default:
      // For platforms without a dedicated bio-link signal type, fall back
      // to name_exact — the merge still happens at confidence 1.0 because
      // it's a Tier 1 explicit link, and the audit reasoning carries the
      // real basis.
      return 'name_exact';
  }
}

function describeMerge(signals: ResolutionSignal[], confidence: number): string {
  const top = [...signals]
    .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
    .slice(0, 3)
    .map((s) => s.signalType)
    .join(', ');
  return `tier2 merge (conf=${round2(confidence)}, signals=[${top}])`;
}

function collectNamePatch(payload: NormalizedPersonPayload): string[] {
  const out: string[] = [];
  if (payload.canonicalName) out.push(payload.canonicalName);
  for (const n of payload.namesSeen ?? []) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function collectEmailPatch(payload: NormalizedPersonPayload): string[] {
  const out: string[] = [];
  if (payload.primaryEmail) out.push(payload.primaryEmail);
  for (const e of payload.emails ?? []) {
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Calibration entry-point uses these — re-export so the script can drive
// the resolver without reaching into private internals.
export { extractAllSignals, computeMatchConfidence, decideAction };
