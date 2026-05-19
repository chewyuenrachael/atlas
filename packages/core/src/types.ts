/**
 * Canonical type definitions for the Cursor Community Atlas.
 *
 * Every entity, edge, enum, and contract referenced in SPEC.md §3 and §4 has
 * a TypeScript shape here. This file is the keystone for compile-time safety
 * across the monorepo. Do not modify without an explicit task — see
 * AGENTS.md "What agents must NOT do".
 *
 * Pattern: every closed string union is exported both as a `const` array
 * (for runtime validation, e.g. zod, drizzle) and as a derived TS type.
 */

// =============================================================================
// Shared scalars
// =============================================================================

/** Branded UUID v4 string. */
export type UUID = string;

/** ISO-8601 timestamp string (UTC). */
export type IsoTimestamp = string;

/** Number constrained to [0, 1]. Used for scores and confidences. */
export type Confidence = number;

/** Generic structured metadata bag. JSON-serializable. */
export type Metadata = Record<string, unknown>;

// =============================================================================
// Enum unions (SPEC.md §3.2.x CHECK constraints)
// =============================================================================

export const SENIORITIES = [
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'vp',
  'cxo',
  'founder',
  'unknown',
] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const LIFECYCLE_STAGES = [
  'lurker',
  'engaged',
  'event_attendee',
  'event_host',
  'ambassador_candidate',
  'ambassador',
  'regional_lead',
  'champion',
  'dormant',
  'churned',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/**
 * Persona classifications. The SPEC does not enumerate the closed set
 * exhaustively (see §3.2.1 `persona_classification TEXT`), so we list the
 * personas referenced explicitly elsewhere in the document plus the
 * obvious complements. Tunable via migration if/when classification taxonomy
 * stabilizes. TODO(spec): confirm canonical persona list with stakeholders.
 */
export const PERSON_PERSONAS = [
  'developer',
  'designer',
  'founder',
  'student',
  'educator',
  'enterprise_buyer',
  'enterprise_champion',
  'open_source_maintainer',
  'content_creator',
  'organizer',
  'ambassador',
  'lurker',
  'unknown',
] as const;
export type PersonPersona = (typeof PERSON_PERSONAS)[number];

export const PLATFORM_IDENTITY_PLATFORMS = [
  'twitter',
  'github',
  'linkedin',
  'luma',
  'slack',
  'discord',
  'forum',
  'cursor_product',
  'hackernews',
  'reddit',
  'youtube',
  'email',
] as const;
export type PlatformIdentityPlatform = (typeof PLATFORM_IDENTITY_PLATFORMS)[number];

export const RESOLUTION_METHODS = [
  'explicit_link',
  'heuristic_match',
  'embedding_match',
  'human_verified',
  'self_reported',
] as const;
export type ResolutionMethod = (typeof RESOLUTION_METHODS)[number];

export const COMPANY_VERTICALS = [
  'finance',
  'healthcare',
  'defense',
  'government',
  'energy',
  'retail',
  'tech',
  'media',
  'manufacturing',
  'consulting',
  'education',
  'legacy_modernization',
  'startup',
  'other',
] as const;
export type CompanyVertical = (typeof COMPANY_VERTICALS)[number];

export const EMPLOYEE_COUNT_TIERS = [
  'seed',
  'startup',
  'growth',
  'midmarket',
  'enterprise',
  'fortune_500',
] as const;
export type EmployeeCountTier = (typeof EMPLOYEE_COUNT_TIERS)[number];

export const TARGET_ACCOUNT_STATUSES = [
  'not_target',
  'prospect',
  'active_opportunity',
  'customer',
  'churned',
] as const;
export type TargetAccountStatus = (typeof TARGET_ACCOUNT_STATUSES)[number];

export const EVENT_PROGRAM_TYPES = [
  'cafe_cursor',
  'hackathon',
  'workshop',
  'meetup',
  'vertical_finance',
  'vertical_healthcare',
  'vertical_defense',
  'campus',
  'ambassador_internal',
  'other',
] as const;
export type EventProgramType = (typeof EVENT_PROGRAM_TYPES)[number];

export const EVENT_FORMATS = ['in_person', 'virtual', 'hybrid'] as const;
export type EventFormat = (typeof EVENT_FORMATS)[number];

export const EVENT_STATUSES = ['proposed', 'scheduled', 'live', 'completed', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const COMMUNICATION_SOURCE_PLATFORMS = [
  'twitter',
  'reddit',
  'hackernews',
  'youtube',
  'forum',
  'slack_public',
  'discord',
  'linkedin',
  'blog',
  'podcast',
] as const;
export type CommunicationSourcePlatform = (typeof COMMUNICATION_SOURCE_PLATFORMS)[number];

export const ARTIFACT_TYPES = [
  'workshop_recording',
  'hackathon_submission',
  'demo_video',
  'rules_template',
  'mcp_config',
  'agent_definition',
  'blog_post',
  'documentation',
  'tutorial',
  'case_study',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const SIGNAL_TYPES = [
  'event_attended',
  'event_hosted',
  'public_post_about_cursor',
  'positive_sentiment',
  'negative_sentiment',
  'product_usage_spike',
  'churn_risk_indicator',
  'employer_change',
  'role_change',
  'enterprise_advocacy',
  'feedback_submitted',
  'feature_request',
  'workflow_contributed',
  'community_help_provided',
  'organizer_candidate_qualified',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const PERSON_EVENT_ROLES = [
  'organizer',
  'co_organizer',
  'speaker',
  'attendee',
  'registered_no_show',
  'declined',
] as const;
export type PersonEventRole = (typeof PERSON_EVENT_ROLES)[number];

export const PERSON_COMPANY_SOURCES = [
  'linkedin',
  'email_domain',
  'self_reported',
  'github_bio',
  'luma_form',
] as const;
export type PersonCompanySource = (typeof PERSON_COMPANY_SOURCES)[number];

export const PERSON_PERSON_EDGE_TYPES = [
  'mentions',
  'replies_to',
  'co_hosts_event',
  'colleague_at_company',
  'mentored_by',
  'introduced_to',
] as const;
export type PersonPersonEdgeType = (typeof PERSON_PERSON_EDGE_TYPES)[number];

export const NORMALIZATION_STATUSES = ['pending', 'success', 'failed', 'skipped'] as const;
export type NormalizationStatus = (typeof NORMALIZATION_STATUSES)[number];

export const RESOLUTION_ACTIONS = ['merge', 'create_new', 'human_review', 'skip'] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

export const RESOLUTION_CONFLICT_STATUSES = [
  'pending_review',
  'confirmed_merge',
  'split_required',
  'resolved',
] as const;
export type ResolutionConflictStatus = (typeof RESOLUTION_CONFLICT_STATUSES)[number];

export const RESOLUTION_DECIDED_BY = ['system', 'human'] as const;
export type ResolutionDecidedBy = (typeof RESOLUTION_DECIDED_BY)[number];

// =============================================================================
// Entities (SPEC.md §3.2)
// =============================================================================

/** SPEC.md §3.2.1 — Person table. */
export interface Person {
  id: UUID;
  canonical_name: string;
  names_seen: string[];
  emails_seen: string[];
  primary_email: string | null;
  location_city: string | null;
  location_country: string | null;
  location_timezone: string | null;
  employer_company_id: UUID | null;
  employer_seen_at: IsoTimestamp | null;
  role: string | null;
  seniority: Seniority | null;
  vertical: string | null;
  languages: string[];
  persona_classification: PersonPersona | null;
  persona_confidence: Confidence | null;
  lifecycle_stage: LifecycleStage | null;
  activity_score: number;
  churn_risk: Confidence;
  first_observed_at: IsoTimestamp;
  last_observed_at: IsoTimestamp;
  is_active: boolean;
  metadata: Metadata;
}

/** SPEC.md §3.2.1 — person_platform_identity. */
export interface PersonPlatformIdentity {
  id: UUID;
  person_id: UUID;
  platform: PlatformIdentityPlatform;
  handle: string;
  platform_user_id: string | null;
  profile_url: string | null;
  follower_count: number | null;
  verified: boolean;
  observed_at: IsoTimestamp;
  resolution_confidence: Confidence;
  resolution_method: ResolutionMethod | null;
}

/** SPEC.md §3.2.2 — Company. */
export interface Company {
  id: UUID;
  canonical_name: string;
  domain: string | null;
  aliases: string[];
  vertical: CompanyVertical | null;
  employee_count_tier: EmployeeCountTier | null;
  fortune_rank: number | null;
  geographic_hq_city: string | null;
  geographic_hq_country: string | null;
  target_account_status: TargetAccountStatus | null;
  enterprise_account_id: string | null;
  aggregate_seat_count: number;
  aggregate_composer_adoption: Confidence | null;
  first_observed_at: IsoTimestamp;
  last_updated_at: IsoTimestamp;
  metadata: Metadata;
}

/** SPEC.md §3.2.3 — Event. */
export interface Event {
  id: UUID;
  title: string;
  description: string | null;
  program_id: UUID | null;
  program_type: EventProgramType | null;
  event_format: EventFormat | null;
  starts_at: IsoTimestamp;
  ends_at: IsoTimestamp | null;
  timezone: string | null;
  venue_city: string | null;
  venue_country: string | null;
  venue_name: string | null;
  venue_company_id: UUID | null;
  host_company_id: UUID | null;
  status: EventStatus | null;
  registered_count: number;
  attended_count: number;
  repeat_attendee_count: number;
  sentiment_score: Confidence | null;
  source_url: string | null;
  luma_event_id: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  metadata: Metadata;
}

/** SPEC.md §3.2.4 — Communication. */
export interface Communication {
  id: UUID;
  source_platform: CommunicationSourcePlatform;
  source_record_id: string;
  author_person_id: UUID | null;
  author_handle_raw: string;
  content_text: string;
  content_url: string | null;
  posted_at: IsoTimestamp;
  sentiment_score: Confidence | null;
  topic_tags: string[];
  vertical_tags: string[];
  engagement_likes: number;
  engagement_replies: number;
  engagement_shares: number;
  engagement_views: number | null;
  is_about_cursor: boolean;
  cursor_relevance_score: Confidence | null;
  /** 1536-dim embedding vector. Surfaced as number[] in the application layer. */
  embedding: number[] | null;
  ingested_at: IsoTimestamp;
}

/** SPEC.md §3.2.5 — Artifact. */
export interface Artifact {
  id: UUID;
  artifact_type: ArtifactType;
  title: string;
  creator_person_id: UUID | null;
  derived_from_event_id: UUID | null;
  content_url: string | null;
  content_text: string | null;
  vertical_tags: string[];
  technical_tags: string[];
  is_public: boolean;
  quality_score: Confidence | null;
  embedding: number[] | null;
  created_at: IsoTimestamp;
  metadata: Metadata;
}

/** SPEC.md §3.2.6 — Program. */
export interface Program {
  id: UUID;
  name: string;
  program_type: string;
  owner_person_id: UUID | null;
  description: string | null;
  is_vertical: boolean;
  vertical: string | null;
  active_cities: string[];
  target_cities: string[];
  kpis: Metadata;
  is_active: boolean;
  created_at: IsoTimestamp;
  metadata: Metadata;
}

/** SPEC.md §3.2.7 — Signal. */
export interface Signal {
  id: UUID;
  person_id: UUID;
  signal_type: SignalType;
  value: number | null;
  confidence: Confidence;
  observed_at: IsoTimestamp;
  source_communication_id: UUID | null;
  source_event_id: UUID | null;
  source_artifact_id: UUID | null;
  decays_by: IsoTimestamp | null;
  metadata: Metadata;
}

// =============================================================================
// Edges (SPEC.md §3.3)
// =============================================================================

/** SPEC.md §3.3.1 — person_event. */
export interface PersonEventEdge {
  id: UUID;
  person_id: UUID;
  event_id: UUID;
  role: PersonEventRole;
  registered_at: IsoTimestamp | null;
  attended_at: IsoTimestamp | null;
  luma_role_raw: string | null;
  post_event_sentiment: Confidence | null;
  post_event_feedback: string | null;
}

/** SPEC.md §3.3.2 — person_company. */
export interface PersonCompanyEdge {
  id: UUID;
  person_id: UUID;
  company_id: UUID;
  role: string | null;
  seniority: Seniority | null;
  is_current: boolean;
  valid_from: IsoTimestamp | null;
  valid_to: IsoTimestamp | null;
  source: PersonCompanySource | null;
  confidence: Confidence;
  observed_at: IsoTimestamp;
}

/** SPEC.md §3.3.3 — person_person_edge. */
export interface PersonPersonEdge {
  id: UUID;
  source_person_id: UUID;
  target_person_id: UUID;
  edge_type: PersonPersonEdgeType;
  strength: number;
  first_observed_at: IsoTimestamp;
  last_observed_at: IsoTimestamp;
  metadata: Metadata;
}

/** SPEC.md §3.3.4 — communication_mentions_person. */
export interface CommunicationMentionsPersonEdge {
  id: UUID;
  communication_id: UUID;
  person_id: UUID;
  confidence: Confidence;
  observed_at: IsoTimestamp;
}

/** SPEC.md §3.3.4 — communication_mentions_company. */
export interface CommunicationMentionsCompanyEdge {
  id: UUID;
  communication_id: UUID;
  company_id: UUID;
  confidence: Confidence;
  observed_at: IsoTimestamp;
}

/** SPEC.md §3.3.4 — artifact_uses_artifact (derivative artifacts). */
export interface ArtifactUsesArtifactEdge {
  id: UUID;
  source_artifact_id: UUID;
  target_artifact_id: UUID;
  metadata: Metadata;
  observed_at: IsoTimestamp;
}

/** SPEC.md §3.3.4 — program_managed_by_person. */
export interface ProgramManagedByPersonEdge {
  id: UUID;
  program_id: UUID;
  person_id: UUID;
  role: string | null;
  is_current: boolean;
  valid_from: IsoTimestamp | null;
  valid_to: IsoTimestamp | null;
}

/** SPEC.md §3.3.4 — event_part_of_program. */
export interface EventPartOfProgramEdge {
  id: UUID;
  event_id: UUID;
  program_id: UUID;
  observed_at: IsoTimestamp;
}

// =============================================================================
// Raw source tables (SPEC.md §3.5)
// =============================================================================

/** Generic raw record envelope (the SPEC repeats this pattern per source). */
export interface RawRecord<TPayload = Metadata> {
  id: UUID;
  source_record_id: string;
  raw_payload: TPayload;
  ingested_at: IsoTimestamp;
  normalized_at: IsoTimestamp | null;
  normalization_status: NormalizationStatus;
  normalization_error: string | null;
}

// =============================================================================
// Audit / event sourcing (SPEC.md §4.4, §4.5, §6.2, §10.5)
// =============================================================================

/** SPEC.md §4.4 — resolution_decision. */
export interface ResolutionDecisionRecord {
  id: UUID;
  decided_at: IsoTimestamp;
  action: ResolutionAction;
  candidate_record_source: string;
  candidate_record_id: string;
  matched_person_id: UUID | null;
  confidence_score: Confidence;
  signals: ResolutionSignal[];
  decided_by: ResolutionDecidedBy;
  human_reviewer: string | null;
  reasoning: string | null;
}

/** SPEC.md §4.5 — resolution_conflict. */
export interface ResolutionConflict {
  id: UUID;
  detected_at: IsoTimestamp;
  person_id: UUID;
  conflicting_evidence: Metadata;
  status: ResolutionConflictStatus;
  resolved_at: IsoTimestamp | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

/** SPEC.md §6.2 — entity_event_log. */
export interface EntityEventLogRecord {
  id: UUID;
  occurred_at: IsoTimestamp;
  entity_type: string;
  entity_id: UUID;
  event_type: string;
  actor: string;
  payload: Metadata;
  causation_id: UUID | null;
  correlation_id: UUID | null;
}

/** SPEC.md §10.5 — access_audit_log. */
export interface AccessAuditLogRecord {
  id: UUID;
  occurred_at: IsoTimestamp;
  user_id: string;
  action: string;
  resource_type: string;
  resource_id: UUID | null;
  success: boolean;
  metadata: Metadata;
}

// =============================================================================
// Identity resolution contracts (SPEC.md §4.2)
// =============================================================================

export const RESOLUTION_SIGNAL_TYPES = [
  'name_exact',
  'name_fuzzy',
  'email_exact',
  'email_domain',
  'employer_match',
  'city_match',
  'timezone_overlap',
  'github_link_in_bio',
  'twitter_link_in_bio',
  'linkedin_link_in_bio',
  'mutual_connection',
  'event_co_attendance',
] as const;
export type ResolutionSignalType = (typeof RESOLUTION_SIGNAL_TYPES)[number];

/** A single piece of evidence that two records refer to the same Person. */
export interface ResolutionSignal {
  signalType: ResolutionSignalType;
  /** 0..1. The intrinsic weight of this signal type. From `RESOLUTION_SIGNAL_WEIGHTS`. */
  weight: number;
  /** 0..1. How sure the system is about *this particular observation*. */
  confidence: Confidence;
}

/** A candidate Person plus the evidence supporting the match. */
export interface MatchCandidate {
  personId: UUID;
  candidateRecord: NormalizedRecord;
  signals: ResolutionSignal[];
}

/** The decision produced by the resolver for one normalized record. */
export interface ResolutionDecision {
  action: ResolutionAction;
  matchedPersonId: UUID | null;
  confidence: Confidence;
  signals: ResolutionSignal[];
  reasoning: string;
}

// =============================================================================
// Adapter contracts (SPEC.md §5.1)
// =============================================================================

/** Cursor opaque to the adapter — used to resume a fetch from a checkpoint. */
export interface Cursor {
  /** Adapter-specific opaque string (e.g. ISO timestamp, page token, max id). */
  value: string;
  /** Optional last-known offset for human-readable debugging. */
  observedAt: IsoTimestamp | null;
}

/** Rate limit configuration consumed by `RateLimiter`. */
export interface RateLimitConfig {
  /** Max requests per `intervalMs`. */
  maxRequestsPerInterval: number;
  /** Bucket window in milliseconds. */
  intervalMs: number;
  /** Burst capacity. Defaults to `maxRequestsPerInterval`. */
  burst?: number;
}

/** What an adapter emits after normalizing one raw record. */
export interface NormalizedRecord<TPayload extends Metadata = Metadata> {
  recordType: 'person' | 'event' | 'communication' | 'artifact' | 'company';
  sourcePlatform: string;
  sourceRecordId: string;
  payload: TPayload;
  observedAt: IsoTimestamp;
}

/**
 * Every source adapter implements this interface. See SPEC.md §5.1 and
 * `packages/adapters/_shared/src/base.ts` for the abstract base class.
 */
export interface SourceAdapter<TRawRecord> {
  /** Stable name, used as the prefix for raw tables and Inngest fn ids. */
  readonly sourceName: string;

  /** Pull records since the given cursor. Yielded eagerly. */
  fetch(cursor?: Cursor): AsyncIterable<TRawRecord>;

  /** Persist a raw record verbatim, idempotently. */
  storeRaw(record: TRawRecord): Promise<{ rawId: UUID }>;

  /** Convert a stored raw record into zero or more NormalizedRecords. */
  normalize(rawId: UUID): Promise<NormalizedRecord[]>;

  /** Rate-limit declaration. The base class enforces this around `fetch`. */
  readonly rateLimit: RateLimitConfig;

  /** Stable per-record key used to deduplicate raw inserts. */
  idempotencyKey(record: TRawRecord): string;
}

// =============================================================================
// Workflow contracts (SPEC.md §8.3)
// =============================================================================

/** Generic output produced by a workflow step. Routed to the review queue. */
export interface WorkflowOutput<TPayload extends Metadata = Metadata> {
  workflowId: string;
  workflowRunId: string;
  producedAt: IsoTimestamp;
  outputType: string;
  payload: TPayload;
  /** Suggested reviewer role: 'operator' or 'admin'. */
  reviewerRole: 'operator' | 'admin';
  /** Optional links to entities to drill into from the review UI. */
  entityRefs?: Array<{ entity_type: string; entity_id: UUID }>;
}

/** A single item waiting on a human in the review queue. */
export interface ReviewQueueItem<TPayload extends Metadata = Metadata> {
  id: UUID;
  output: WorkflowOutput<TPayload>;
  status: 'pending' | 'approved' | 'rejected' | 'edited';
  enqueued_at: IsoTimestamp;
  decided_at: IsoTimestamp | null;
  decided_by: string | null;
  decision_note: string | null;
}

// =============================================================================
// Re-export Result for callers that import everything from @atlas/core
// =============================================================================

export type { Result, Ok, Err } from './result.js';
