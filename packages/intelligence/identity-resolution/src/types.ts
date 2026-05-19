/**
 * Internal types for the identity resolution package.
 *
 * The canonical types (`NormalizedRecord`, `ResolutionSignal`,
 * `MatchCandidate`, `ResolutionDecision`, etc.) live in `@atlas/core`. This
 * file defines the *internal* contracts that the resolver, candidate lookup,
 * and store implementations exchange.
 *
 * Spec ref: SPEC.md §4.2, §4.3, §4.4.
 */
import type {
  IsoTimestamp,
  Metadata,
  NormalizedRecord,
  PlatformIdentityPlatform,
  ResolutionAction,
  ResolutionSignal,
  UUID,
} from '@atlas/core';

/**
 * Typed payload for a NormalizedRecord whose `recordType` is `'person'`.
 *
 * Adapters carry source-specific shapes in `NormalizedRecord.payload`. Before
 * a record reaches the resolver, the normalization step projects it into
 * this canonical Person payload. Every field is optional because real sources
 * are partial (Luma rarely has GitHub handles, GitHub rarely has emails,
 * etc.). Resolution combines fields across many records.
 */
export interface NormalizedPersonPayload {
  /** Display name as observed on the source. Required for any useful match. */
  canonicalName?: string;
  /** All name variants observed on this record (legal, display, handle-derived). */
  namesSeen?: string[];
  /** Emails associated with this record. Lowercased before comparison. */
  emails?: string[];
  /** Best-guess "primary" email if the source distinguishes one. */
  primaryEmail?: string;
  /** Self-reported or inferred city. */
  city?: string;
  /** Self-reported or inferred country. */
  country?: string;
  /** IANA timezone (e.g. `America/Los_Angeles`). */
  timezone?: string;
  /** Resolved Atlas Company id if the employer was matched upstream. */
  employerCompanyId?: UUID;
  /** Raw employer string when the Company has not been resolved yet. */
  employerName?: string;
  /** When the employer was observed (drives conflict detection). */
  employerObservedAt?: IsoTimestamp;
  /** The platform identity this record introduces, if any. */
  platformIdentity?: {
    platform: PlatformIdentityPlatform;
    handle: string;
    platformUserId?: string;
    profileUrl?: string;
    followerCount?: number;
    verified?: boolean;
  };
  /**
   * Handles extracted from bio/profile URLs across platforms. Populated by
   * adapters that parse "links in bio" (e.g. a Luma form pointing to GitHub).
   */
  bioLinks?: {
    github?: string;
    twitter?: string;
    linkedin?: string;
  };
  /** Atlas Event ids this record references (e.g. attendance, organization). */
  eventIds?: UUID[];
  /** Atlas Person ids that this record's author has interacted with. */
  connectedPersonIds?: UUID[];
  /** Arbitrary structured metadata for downstream observability. */
  metadata?: Metadata;
  /** Index signature so the payload satisfies `Metadata = Record<string, unknown>`. */
  [key: string]: unknown;
}

/** A NormalizedRecord narrowed to the person-typed payload. */
export type NormalizedPersonRecord = NormalizedRecord<NormalizedPersonPayload> & {
  recordType: 'person';
};

/**
 * Final outcome the resolver returns to its caller.
 *
 * - `action` and `confidence` mirror the audit row.
 * - `personId` is the canonical person the record was attached to (or
 *   created as), or `null` when no merge happened (human_review / skip).
 * - `candidates` holds the top-N alternatives we evaluated, for review UI.
 */
export interface ResolutionOutcome {
  action: ResolutionAction;
  personId: UUID | null;
  confidence: number;
  signals: ResolutionSignal[];
  reasoning: string;
  candidates: ResolutionCandidateView[];
  resolutionDecisionId: UUID | null;
  conflictDetected: boolean;
}

/** A candidate plus the audit-friendly view of why it was considered. */
export interface ResolutionCandidateView {
  personId: UUID;
  confidence: number;
  signals: ResolutionSignal[];
}

/**
 * A new-record-vs-candidate scoring result. Held internally before the
 * decision engine picks a winner.
 */
export interface ScoredCandidate {
  personId: UUID;
  signals: ResolutionSignal[];
  confidence: number;
}
