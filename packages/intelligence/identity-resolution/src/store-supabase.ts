/**
 * Supabase-backed implementations of {@link PersonStore} and
 * {@link ResolutionAuditStore}.
 *
 * Phase 1C shipped the resolver against an in-memory store. Phase 1D wires
 * the resolver to the real database via the named query helpers in
 * `@atlas/db/queries/*`. The resolver itself is unchanged — it still depends
 * only on the {@link PersonStore} / {@link ResolutionAuditStore} interfaces.
 *
 * Error handling: the query helpers return `Result<T, AtlasError>`, but the
 * store interfaces predate `Result` and use plain async functions. We
 * unwrap `Result` and rethrow as `ResolutionError` so the resolver's existing
 * `tryAsync` wrapper around `runResolve` catches and surfaces the failure as
 * a `RESOLUTION_INTERNAL_ERROR`.
 *
 * SPEC ref: SPEC.md §4.2, §4.3, §4.4, §4.5.
 */
import {
  ResolutionError,
  type IsoTimestamp,
  type Person,
  type PersonPlatformIdentity,
  type PlatformIdentityPlatform,
  type ResolutionDecisionRecord,
  type UUID,
} from '@atlas/core';
import { AuditQueries, EventQueries, PersonQueries, getServiceClient } from '@atlas/db';
import type {
  HumanReviewQueueItem,
  NewPersonInput,
  NewPlatformIdentityInput,
  PersonMergePatch,
  PersonStore,
  PersonWithContext,
  ResolutionAuditStore,
} from './store.js';

// ---------------------------------------------------------------------------
// PersonStore
// ---------------------------------------------------------------------------

/**
 * Supabase-backed {@link PersonStore}. Every query goes through the helpers
 * in `@atlas/db/queries/person.ts` so RLS / connection management / audit
 * coverage stay centralized.
 *
 * @example
 * ```ts
 * const store = new SupabasePersonStore();
 * const audit = new SupabaseResolutionAuditStore();
 * const resolver = new IdentityResolver({ store, audit });
 * await resolver.resolve(record);
 * ```
 */
export class SupabasePersonStore implements PersonStore {
  async findByEmail(email: string): Promise<PersonWithContext | null> {
    const r = await PersonQueries.findPersonsByEmail(email);
    if (!r.ok) throw asResolutionError('findByEmail', r.error, { email });
    const first = r.value[0];
    if (!first) return null;
    return this.hydrate(first);
  }

  async findByPlatformHandle(
    platform: PlatformIdentityPlatform,
    handle: string,
  ): Promise<PersonWithContext | null> {
    const r = await PersonQueries.findPersonsByPlatformHandle(platform, handle);
    if (!r.ok) throw asResolutionError('findByPlatformHandle', r.error, { platform, handle });
    const first = r.value[0];
    if (!first) return null;
    return this.hydrate(first);
  }

  async findByNameTrigram(name: string, limit: number): Promise<PersonWithContext[]> {
    const r = await PersonQueries.findPersonsByNameTrigram(name, limit);
    if (!r.ok) throw asResolutionError('findByNameTrigram', r.error, { name, limit });
    const out: PersonWithContext[] = [];
    for (const person of r.value) {
      out.push(await this.hydrate(person));
    }
    return out;
  }

  async getById(personId: UUID): Promise<PersonWithContext | null> {
    const r = await PersonQueries.getPersonById(personId);
    if (!r.ok) throw asResolutionError('getById', r.error, { personId });
    if (!r.value) return null;
    return this.hydrate(r.value);
  }

  async insertPerson(input: NewPersonInput): Promise<UUID> {
    const r = await PersonQueries.createPerson({
      canonical_name: input.canonicalName,
      names_seen: input.namesSeen,
      emails_seen: input.emailsSeen,
      primary_email: input.primaryEmail,
      location_city: input.locationCity,
      location_country: input.locationCountry,
      location_timezone: input.locationTimezone,
      first_observed_at: input.firstObservedAt,
      last_observed_at: input.lastObservedAt,
      metadata: input.metadata,
    });
    if (!r.ok) throw asResolutionError('insertPerson', r.error, { input });
    return r.value.id;
  }

  async updatePerson(personId: UUID, patch: PersonMergePatch): Promise<void> {
    // The interface gives us "additions" semantics for arrays; we have to
    // read-modify-write to merge with what's already stored.
    const existing = await PersonQueries.getPersonById(personId);
    if (!existing.ok) throw asResolutionError('updatePerson.read', existing.error, { personId });
    if (!existing.value) return;

    const namesSeen = mergeUnique(existing.value.names_seen, patch.addNamesSeen ?? []);
    const emailsSeen = mergeUnique(existing.value.emails_seen, patch.addEmailsSeen ?? []).filter(
      (s) => s.length > 0,
    );

    const update: Parameters<typeof PersonQueries.updatePerson>[1] = {
      names_seen: namesSeen,
      emails_seen: emailsSeen,
      primary_email:
        patch.primaryEmail !== undefined ? patch.primaryEmail : existing.value.primary_email,
      location_city: patch.city !== undefined ? patch.city : existing.value.location_city,
      location_country:
        patch.country !== undefined ? patch.country : existing.value.location_country,
      location_timezone:
        patch.timezone !== undefined ? patch.timezone : existing.value.location_timezone,
    };

    const r = await PersonQueries.updatePerson(personId, update);
    if (!r.ok) throw asResolutionError('updatePerson.write', r.error, { personId });
  }

  async insertPlatformIdentity(input: NewPlatformIdentityInput): Promise<void> {
    const r = await PersonQueries.addPlatformIdentity(input.personId, {
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
    });
    if (!r.ok) {
      // Unique violations (`23505`) are expected on re-runs: the same
      // (platform, handle) pair will already be attached to this Person.
      // Swallow them so the workflow stays idempotent. Other errors propagate.
      const pgrstCode = r.error.context['pgrstCode'];
      if (pgrstCode === '23505') return;
      throw asResolutionError('insertPlatformIdentity', r.error, { input });
    }
  }

  /**
   * Hydrate a `Person` row into the `PersonWithContext` shape the resolver
   * expects. Auxiliary tables (`person_platform_identity`, `person_event`,
   * `person_person_edge`) are queried directly via the service client because
   * exposing dedicated read helpers for every join is out of Phase 1D scope.
   */
  private async hydrate(person: Person): Promise<PersonWithContext> {
    const svc = getServiceClient();
    if (!svc.ok) throw asResolutionError('hydrate.client', svc.error, { personId: person.id });
    const sb = svc.value;

    const [pi, pe, ppe] = await Promise.all([
      sb.from('person_platform_identity').select('*').eq('person_id', person.id),
      sb.from('person_event').select('event_id').eq('person_id', person.id),
      sb.from('person_person_edge').select('target_person_id').eq('source_person_id', person.id),
    ]);
    if (pi.error)
      throw asResolutionError('hydrate.pi', pi.error, { personId: person.id });
    if (pe.error)
      throw asResolutionError('hydrate.pe', pe.error, { personId: person.id });
    if (ppe.error)
      throw asResolutionError('hydrate.ppe', ppe.error, { personId: person.id });

    return {
      person,
      platformIdentities: (pi.data ?? []) as PersonPlatformIdentity[],
      eventIds: ((pe.data ?? []) as Array<{ event_id: UUID }>).map((r) => r.event_id),
      connectedPersonIds: ((ppe.data ?? []) as Array<{ target_person_id: UUID }>).map(
        (r) => r.target_person_id,
      ),
      currentEmployerCompanyId: person.employer_company_id,
    };
  }
}

// ---------------------------------------------------------------------------
// ResolutionAuditStore
// ---------------------------------------------------------------------------

/**
 * Supabase-backed {@link ResolutionAuditStore}. Writes to `resolution_decision`,
 * `human_review_queue`, and `resolution_conflict`.
 *
 * @example
 * ```ts
 * const audit = new SupabaseResolutionAuditStore();
 * const resolver = new IdentityResolver({ store, audit });
 * ```
 */
export class SupabaseResolutionAuditStore implements ResolutionAuditStore {
  async writeDecision(
    record: Omit<ResolutionDecisionRecord, 'id' | 'decided_at'> & {
      decided_at?: IsoTimestamp;
    },
  ): Promise<UUID> {
    const r = await AuditQueries.logResolution({
      action: record.action,
      candidateRecordSource: record.candidate_record_source,
      candidateRecordId: record.candidate_record_id,
      matchedPersonId: record.matched_person_id,
      confidenceScore: record.confidence_score,
      signals: record.signals,
      decidedBy: record.decided_by,
      humanReviewer: record.human_reviewer,
      reasoning: record.reasoning,
    });
    if (!r.ok) throw asResolutionError('writeDecision', r.error, { record });
    return r.value.id;
  }

  async enqueueHumanReview(item: HumanReviewQueueItem): Promise<UUID> {
    const r = await AuditQueries.enqueueReviewItem({
      itemType: item.itemType,
      payload: {
        enqueued_at: item.enqueuedAt,
        candidate_source: item.candidateSource,
        candidate_record_id: item.candidateRecordId,
        candidate_payload: item.candidatePayload,
        top_candidates: item.topCandidates,
        action: item.action,
        confidence: item.confidence,
      },
    });
    if (!r.ok) throw asResolutionError('enqueueHumanReview', r.error, { item });
    return r.value;
  }

  async writeConflict(
    conflict: Parameters<ResolutionAuditStore['writeConflict']>[0],
  ): Promise<UUID> {
    const r = await AuditQueries.writeResolutionConflict({
      personId: conflict.person_id,
      conflictingEvidence: conflict.conflicting_evidence,
      status: conflict.status,
      detectedAt: conflict.detected_at,
      resolutionNote: conflict.resolution_note,
    });
    if (!r.ok) throw asResolutionError('writeConflict', r.error, { conflict });
    return r.value.id;
  }
}

// ---------------------------------------------------------------------------
// Supabase-aware helpers for the pipeline (not part of the store interfaces)
// ---------------------------------------------------------------------------

/**
 * Find the Atlas `event.id` for a given Luma slug. Surfaces from the
 * pipeline so we can attach `person_event` organizer edges after the
 * resolver has produced a `personId`.
 */
export async function findEventIdByLumaId(lumaEventId: string): Promise<UUID | null> {
  const r = await EventQueries.findEventByLumaId(lumaEventId);
  if (!r.ok) throw asResolutionError('findEventIdByLumaId', r.error, { lumaEventId });
  return r.value?.id ?? null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...a, ...b]) {
    if (v === null || v === undefined) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function asResolutionError(
  helper: string,
  cause: unknown,
  context: Record<string, unknown>,
): ResolutionError {
  const message =
    cause && typeof cause === 'object' && 'message' in cause
      ? String((cause as { message: unknown }).message)
      : String(cause);
  return new ResolutionError(
    `SupabaseStore.${helper} failed: ${message}`,
    'RESOLUTION_INTERNAL_ERROR',
    context,
    cause,
  );
}
