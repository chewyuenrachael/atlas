/**
 * PersonStore — the persistence boundary for the identity resolver.
 *
 * The resolver does not import `@atlas/db` directly. Instead, it accepts a
 * `PersonStore` (and `ResolutionAuditStore`) as a constructor dependency.
 * Two implementations are provided:
 *
 *   1. {@link InMemoryPersonStore} — used by unit tests, the calibration
 *      script, and any caller that wants a deterministic, side-effect-free
 *      resolver run.
 *   2. (Phase 2+) a Supabase-backed implementation that delegates to the
 *      named query helpers in `@atlas/db/queries/person`. That wiring lands
 *      with the Phase 1 migrations + query implementations — the resolver
 *      itself stays agnostic.
 *
 * Spec ref: SPEC.md §3.2.1, §4.2, §4.3, §4.4, §4.5.
 */
import type {
  IsoTimestamp,
  Metadata,
  Person,
  PersonPersonEdge,
  PersonPlatformIdentity,
  PlatformIdentityPlatform,
  ResolutionAction,
  ResolutionConflict,
  ResolutionDecisionRecord,
  ResolutionSignal,
  UUID,
} from '@atlas/core';

import { jaroWinklerSimilarity } from './jaro-winkler.js';
import { normalizeEmail, normalizeHandle, normalizeName } from './normalize.js';

// ---------------------------------------------------------------------------
// Interfaces consumed by the resolver
// ---------------------------------------------------------------------------

/** A flattened Person + the auxiliary tables the resolver needs to score. */
export interface PersonWithContext {
  person: Person;
  platformIdentities: PersonPlatformIdentity[];
  eventIds: UUID[];
  connectedPersonIds: UUID[];
  currentEmployerCompanyId: UUID | null;
}

/** What the resolver writes to the Person side of the world on `merge`. */
export interface PersonMergePatch {
  addNamesSeen?: string[];
  addEmailsSeen?: string[];
  primaryEmail?: string | null;
  city?: string | null;
  country?: string | null;
  timezone?: string | null;
  lastObservedAt: IsoTimestamp;
}

/** Fields needed to construct a brand new Person on `create_new`. */
export interface NewPersonInput {
  canonicalName: string;
  namesSeen: string[];
  emailsSeen: string[];
  primaryEmail: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  locationTimezone: string | null;
  firstObservedAt: IsoTimestamp;
  lastObservedAt: IsoTimestamp;
  metadata: Metadata;
}

/** New platform identity to append (always paired with merge / create). */
export interface NewPlatformIdentityInput {
  personId: UUID;
  platform: PlatformIdentityPlatform;
  handle: string;
  platformUserId: string | null;
  profileUrl: string | null;
  followerCount: number | null;
  verified: boolean;
  observedAt: IsoTimestamp;
  resolutionConfidence: number;
  resolutionMethod:
    | 'explicit_link'
    | 'heuristic_match'
    | 'embedding_match'
    | 'human_verified'
    | 'self_reported';
}

/** Storage contract the resolver depends on. */
export interface PersonStore {
  findByEmail(email: string): Promise<PersonWithContext | null>;
  findByPlatformHandle(
    platform: PlatformIdentityPlatform,
    handle: string,
  ): Promise<PersonWithContext | null>;
  findByNameTrigram(name: string, limit: number): Promise<PersonWithContext[]>;
  getById(personId: UUID): Promise<PersonWithContext | null>;
  insertPerson(input: NewPersonInput): Promise<UUID>;
  updatePerson(personId: UUID, patch: PersonMergePatch): Promise<void>;
  insertPlatformIdentity(input: NewPlatformIdentityInput): Promise<void>;
}

/** Audit + human-review side effects. */
export interface ResolutionAuditStore {
  writeDecision(
    record: Omit<ResolutionDecisionRecord, 'id' | 'decided_at'> & {
      decided_at?: IsoTimestamp;
    },
  ): Promise<UUID>;
  enqueueHumanReview(item: HumanReviewQueueItem): Promise<UUID>;
  writeConflict(
    conflict: Omit<ResolutionConflict, 'id' | 'detected_at'> & {
      detected_at?: IsoTimestamp;
    },
  ): Promise<UUID>;
}

/** Payload enqueued onto the human_review_queue for an identity decision. */
export interface HumanReviewQueueItem {
  itemType: 'identity_resolution_review';
  enqueuedAt: IsoTimestamp;
  candidateSource: string;
  candidateRecordId: string;
  candidatePayload: Metadata;
  topCandidates: Array<{
    personId: UUID;
    confidence: number;
    signals: ResolutionSignal[];
  }>;
  action: ResolutionAction;
  confidence: number;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

interface SeedPerson {
  id: UUID;
  canonical_name: string;
  names_seen?: string[];
  emails_seen?: string[];
  primary_email?: string | null;
  location_city?: string | null;
  location_country?: string | null;
  location_timezone?: string | null;
  employer_company_id?: UUID | null;
  metadata?: Metadata;
  platformIdentities?: PersonPlatformIdentity[];
  eventIds?: UUID[];
  connectedPersonIds?: UUID[];
}

let inMemoryIdCounter = 0;
function nextId(prefix: string): UUID {
  inMemoryIdCounter += 1;
  return `${prefix}-${String(inMemoryIdCounter).padStart(6, '0')}`;
}

/**
 * Test/in-memory implementation of `PersonStore` + `ResolutionAuditStore`.
 *
 * Backed by simple `Map`s. Trigram lookup is approximated with Jaro–Winkler
 * over normalized names, which is what the Postgres `pg_trgm` index would
 * roughly approximate at small scale.
 *
 * @example
 * ```ts
 * const store = new InMemoryPersonStore();
 * await store.seedPerson({ id: 'p-001', canonical_name: 'Alice Chen' });
 * const resolver = new IdentityResolver({ store, audit: store });
 * ```
 */
export class InMemoryPersonStore implements PersonStore, ResolutionAuditStore {
  private readonly persons = new Map<UUID, Person>();
  private readonly platformIdentitiesByPerson = new Map<UUID, PersonPlatformIdentity[]>();
  private readonly eventIdsByPerson = new Map<UUID, UUID[]>();
  private readonly edgesByPerson = new Map<UUID, PersonPersonEdge[]>();

  private readonly emailIndex = new Map<string, UUID>();
  private readonly platformHandleIndex = new Map<string, UUID>();

  readonly decisions: ResolutionDecisionRecord[] = [];
  readonly reviewQueue: Array<HumanReviewQueueItem & { id: UUID }> = [];
  readonly conflicts: ResolutionConflict[] = [];

  // ----- seeding helpers ------------------------------------------------

  /** Populate the store with a Person and associated context for tests. */
  seedPerson(seed: SeedPerson): UUID {
    const now = '2025-01-01T00:00:00.000Z';
    const person: Person = {
      id: seed.id,
      canonical_name: seed.canonical_name,
      names_seen: seed.names_seen ?? [seed.canonical_name],
      emails_seen: seed.emails_seen ?? [],
      primary_email: seed.primary_email ?? null,
      location_city: seed.location_city ?? null,
      location_country: seed.location_country ?? null,
      location_timezone: seed.location_timezone ?? null,
      employer_company_id: seed.employer_company_id ?? null,
      employer_seen_at: null,
      role: null,
      seniority: null,
      vertical: null,
      languages: [],
      persona_classification: null,
      persona_confidence: null,
      lifecycle_stage: null,
      activity_score: 0,
      churn_risk: 0,
      first_observed_at: now,
      last_observed_at: now,
      is_active: true,
      metadata: seed.metadata ?? {},
    };
    this.persons.set(person.id, person);

    const identities = seed.platformIdentities ?? [];
    this.platformIdentitiesByPerson.set(person.id, identities);
    for (const id of identities) {
      this.platformHandleIndex.set(`${id.platform}:${normalizeHandle(id.handle)}`, person.id);
    }

    for (const email of person.emails_seen) {
      const e = normalizeEmail(email);
      if (e) this.emailIndex.set(e, person.id);
    }
    if (person.primary_email) {
      this.emailIndex.set(normalizeEmail(person.primary_email), person.id);
    }

    this.eventIdsByPerson.set(person.id, seed.eventIds ?? []);
    if (seed.connectedPersonIds) {
      const edges: PersonPersonEdge[] = seed.connectedPersonIds.map((target) => ({
        id: nextId('edge'),
        source_person_id: person.id,
        target_person_id: target,
        edge_type: 'mentions',
        strength: 1,
        first_observed_at: now,
        last_observed_at: now,
        metadata: {},
      }));
      this.edgesByPerson.set(person.id, edges);
    } else {
      this.edgesByPerson.set(person.id, []);
    }

    return person.id;
  }

  /** Direct read helper for tests / calibration. */
  getPersonRaw(personId: UUID): Person | null {
    return this.persons.get(personId) ?? null;
  }

  /** Total Person count, useful for calibration histograms. */
  size(): number {
    return this.persons.size;
  }

  // ----- PersonStore ----------------------------------------------------

  async findByEmail(email: string): Promise<PersonWithContext | null> {
    const id = this.emailIndex.get(normalizeEmail(email));
    if (!id) return null;
    return this.getById(id);
  }

  async findByPlatformHandle(
    platform: PlatformIdentityPlatform,
    handle: string,
  ): Promise<PersonWithContext | null> {
    const id = this.platformHandleIndex.get(`${platform}:${normalizeHandle(handle)}`);
    if (!id) return null;
    return this.getById(id);
  }

  async findByNameTrigram(name: string, limit: number): Promise<PersonWithContext[]> {
    const target = normalizeName(name);
    if (!target) return [];
    const scored: Array<{ id: UUID; score: number }> = [];
    for (const person of this.persons.values()) {
      const allNames = [person.canonical_name, ...person.names_seen];
      let best = 0;
      for (const n of allNames) {
        const score = jaroWinklerSimilarity(target, normalizeName(n));
        if (score > best) best = score;
      }
      if (best >= 0.8) {
        scored.push({ id: person.id, score: best });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const slice = scored.slice(0, limit);
    const results: PersonWithContext[] = [];
    for (const s of slice) {
      const ctx = await this.getById(s.id);
      if (ctx) results.push(ctx);
    }
    return results;
  }

  async getById(personId: UUID): Promise<PersonWithContext | null> {
    const person = this.persons.get(personId);
    if (!person) return null;
    return {
      person,
      platformIdentities: this.platformIdentitiesByPerson.get(personId) ?? [],
      eventIds: this.eventIdsByPerson.get(personId) ?? [],
      connectedPersonIds: (this.edgesByPerson.get(personId) ?? []).map((e) => e.target_person_id),
      currentEmployerCompanyId: person.employer_company_id,
    };
  }

  async insertPerson(input: NewPersonInput): Promise<UUID> {
    const id = nextId('person');
    const person: Person = {
      id,
      canonical_name: input.canonicalName,
      names_seen: input.namesSeen,
      emails_seen: input.emailsSeen,
      primary_email: input.primaryEmail,
      location_city: input.locationCity,
      location_country: input.locationCountry,
      location_timezone: input.locationTimezone,
      employer_company_id: null,
      employer_seen_at: null,
      role: null,
      seniority: null,
      vertical: null,
      languages: [],
      persona_classification: null,
      persona_confidence: null,
      lifecycle_stage: null,
      activity_score: 0,
      churn_risk: 0,
      first_observed_at: input.firstObservedAt,
      last_observed_at: input.lastObservedAt,
      is_active: true,
      metadata: input.metadata,
    };
    this.persons.set(id, person);
    this.platformIdentitiesByPerson.set(id, []);
    this.eventIdsByPerson.set(id, []);
    this.edgesByPerson.set(id, []);
    for (const email of input.emailsSeen) {
      const e = normalizeEmail(email);
      if (e) this.emailIndex.set(e, id);
    }
    if (input.primaryEmail) {
      this.emailIndex.set(normalizeEmail(input.primaryEmail), id);
    }
    return id;
  }

  async updatePerson(personId: UUID, patch: PersonMergePatch): Promise<void> {
    const existing = this.persons.get(personId);
    if (!existing) return;
    const namesSeen = mergeUnique(existing.names_seen, patch.addNamesSeen ?? []);
    const emailsSeen = mergeUnique(
      existing.emails_seen.map(normalizeEmail),
      (patch.addEmailsSeen ?? []).map(normalizeEmail),
    ).filter(Boolean);
    const next: Person = {
      ...existing,
      names_seen: namesSeen,
      emails_seen: emailsSeen,
      primary_email: patch.primaryEmail !== undefined ? patch.primaryEmail : existing.primary_email,
      location_city: patch.city !== undefined ? patch.city : existing.location_city,
      location_country: patch.country !== undefined ? patch.country : existing.location_country,
      location_timezone: patch.timezone !== undefined ? patch.timezone : existing.location_timezone,
      last_observed_at: patch.lastObservedAt,
    };
    this.persons.set(personId, next);
    for (const e of emailsSeen) this.emailIndex.set(e, personId);
    if (next.primary_email) this.emailIndex.set(normalizeEmail(next.primary_email), personId);
  }

  async insertPlatformIdentity(input: NewPlatformIdentityInput): Promise<void> {
    const identity: PersonPlatformIdentity = {
      id: nextId('ppi'),
      person_id: input.personId,
      platform: input.platform,
      handle: input.handle,
      platform_user_id: input.platformUserId,
      profile_url: input.profileUrl,
      follower_count: input.followerCount,
      verified: input.verified,
      observed_at: input.observedAt,
      resolution_confidence: input.resolutionConfidence,
      resolution_method: input.resolutionMethod,
    };
    const list = this.platformIdentitiesByPerson.get(input.personId) ?? [];
    list.push(identity);
    this.platformIdentitiesByPerson.set(input.personId, list);
    this.platformHandleIndex.set(
      `${input.platform}:${normalizeHandle(input.handle)}`,
      input.personId,
    );
  }

  // ----- ResolutionAuditStore ------------------------------------------

  async writeDecision(
    record: Omit<ResolutionDecisionRecord, 'id' | 'decided_at'> & {
      decided_at?: IsoTimestamp;
    },
  ): Promise<UUID> {
    const id = nextId('decision');
    const full: ResolutionDecisionRecord = {
      id,
      decided_at: record.decided_at ?? new Date().toISOString(),
      action: record.action,
      candidate_record_source: record.candidate_record_source,
      candidate_record_id: record.candidate_record_id,
      matched_person_id: record.matched_person_id,
      confidence_score: record.confidence_score,
      signals: record.signals,
      decided_by: record.decided_by,
      human_reviewer: record.human_reviewer,
      reasoning: record.reasoning,
    };
    this.decisions.push(full);
    return id;
  }

  async enqueueHumanReview(item: HumanReviewQueueItem): Promise<UUID> {
    const id = nextId('review');
    this.reviewQueue.push({ ...item, id });
    return id;
  }

  async writeConflict(
    conflict: Omit<ResolutionConflict, 'id' | 'detected_at'> & {
      detected_at?: IsoTimestamp;
    },
  ): Promise<UUID> {
    const id = nextId('conflict');
    const full: ResolutionConflict = {
      id,
      detected_at: conflict.detected_at ?? new Date().toISOString(),
      person_id: conflict.person_id,
      conflicting_evidence: conflict.conflicting_evidence,
      status: conflict.status,
      resolved_at: conflict.resolved_at,
      resolved_by: conflict.resolved_by,
      resolution_note: conflict.resolution_note,
    };
    this.conflicts.push(full);
    return id;
  }

  /** Test helper: reset the global id counter so tests are deterministic. */
  static resetIdCounter(): void {
    inMemoryIdCounter = 0;
  }
}

function mergeUnique<T>(a: readonly T[], b: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of [...a, ...b]) {
    if (v === null || v === undefined) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
