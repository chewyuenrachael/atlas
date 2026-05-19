/**
 * Audit trail writer.
 *
 * Every resolver decision — merge, create_new, human_review, skip — produces
 * exactly one `resolution_decision` row. The row is the source of truth for
 * any later dispute: a human can replay the signals and trace where the
 * algorithm went.
 *
 * Spec ref: SPEC.md §4.4.
 */
import type { IsoTimestamp, Metadata, ResolutionAction, ResolutionSignal, UUID } from '@atlas/core';

import type { HumanReviewQueueItem, ResolutionAuditStore } from './store.js';
import type { ResolutionCandidateView } from './types.js';

/** Arguments accepted by {@link writeResolutionDecision}. */
export interface WriteResolutionDecisionArgs {
  action: ResolutionAction;
  candidateRecordSource: string;
  candidateRecordId: string;
  matchedPersonId: UUID | null;
  confidence: number;
  signals: ResolutionSignal[];
  reasoning: string;
  decidedAt?: IsoTimestamp;
}

/**
 * Write one `resolution_decision` row through the audit store.
 *
 * @example
 * ```ts
 * await writeResolutionDecision(audit, {
 *   action: 'merge',
 *   candidateRecordSource: 'luma',
 *   candidateRecordId: 'evt-123:attendee-456',
 *   matchedPersonId: 'p-001',
 *   confidence: 0.97,
 *   signals: [...],
 *   reasoning: 'email_exact + name_exact',
 * });
 * ```
 */
export async function writeResolutionDecision(
  audit: ResolutionAuditStore,
  args: WriteResolutionDecisionArgs,
): Promise<UUID> {
  return audit.writeDecision({
    decided_at: args.decidedAt ?? new Date().toISOString(),
    action: args.action,
    candidate_record_source: args.candidateRecordSource,
    candidate_record_id: args.candidateRecordId,
    matched_person_id: args.matchedPersonId,
    confidence_score: round2(args.confidence),
    signals: args.signals,
    decided_by: 'system',
    human_reviewer: null,
    reasoning: args.reasoning,
  });
}

/** Arguments accepted by {@link enqueueHumanReviewItem}. */
export interface EnqueueHumanReviewArgs {
  candidateRecordSource: string;
  candidateRecordId: string;
  candidatePayload: Metadata;
  action: ResolutionAction;
  confidence: number;
  topCandidates: ResolutionCandidateView[];
  enqueuedAt?: IsoTimestamp;
}

/**
 * Enqueue an `identity_resolution_review` item with the new record plus the
 * top-3 candidates and their signals.
 */
export async function enqueueHumanReviewItem(
  audit: ResolutionAuditStore,
  args: EnqueueHumanReviewArgs,
): Promise<UUID> {
  const item: HumanReviewQueueItem = {
    itemType: 'identity_resolution_review',
    enqueuedAt: args.enqueuedAt ?? new Date().toISOString(),
    candidateSource: args.candidateRecordSource,
    candidateRecordId: args.candidateRecordId,
    candidatePayload: args.candidatePayload,
    topCandidates: args.topCandidates.slice(0, 3).map((c) => ({
      personId: c.personId,
      confidence: round2(c.confidence),
      signals: c.signals,
    })),
    action: args.action,
    confidence: round2(args.confidence),
  };
  return audit.enqueueHumanReview(item);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
