/**
 * Conflict detection — flag potential bad merges before / after they happen.
 *
 * The resolver calls `detectConflict` whenever it is about to merge a new
 * record into an existing Person. If a meaningful contradiction is found we
 * still proceed with the merge (the new evidence often *is* a job change),
 * but a `resolution_conflict` row is written so a human can review.
 *
 * Spec ref: SPEC.md §4.5.
 */
import type { Metadata, UUID } from '@atlas/core';

import { normalizeName } from './normalize.js';
import type { PersonStore, ResolutionAuditStore } from './store.js';
import type { NormalizedPersonPayload } from './types.js';

/**
 * Return true when the new record contradicts the existing Person along a
 * field worth flagging:
 *
 *   - Different current employer observed close in time
 *   - Different self-reported city when both are present
 *
 * Side effect on `true`: inserts a row into `resolution_conflict` (via the
 * audit store) with the conflicting evidence captured.
 *
 * @example
 * ```ts
 * const conflicted = await detectConflict(personId, payload, store, audit);
 * if (conflicted) log.warn({ personId }, 'identity merge flagged for review');
 * ```
 */
export async function detectConflict(
  personId: UUID,
  newRecord: NormalizedPersonPayload,
  store: PersonStore,
  audit: ResolutionAuditStore,
): Promise<boolean> {
  const candidate = await store.getById(personId);
  if (!candidate) return false;

  const conflicts: Metadata = {};

  // Employer conflict — both sides know an employer, and they disagree.
  if (
    newRecord.employerCompanyId &&
    candidate.currentEmployerCompanyId &&
    newRecord.employerCompanyId !== candidate.currentEmployerCompanyId
  ) {
    conflicts['employer'] = {
      existing_company_id: candidate.currentEmployerCompanyId,
      new_company_id: newRecord.employerCompanyId,
      new_observed_at: newRecord.employerObservedAt ?? null,
      existing_observed_at: candidate.person.employer_seen_at,
    };
  }

  // City conflict — both known, different normalized values.
  const newCity = normalizeName(newRecord.city);
  const existingCity = normalizeName(candidate.person.location_city);
  if (newCity && existingCity && newCity !== existingCity) {
    conflicts['city'] = {
      existing: candidate.person.location_city,
      proposed: newRecord.city,
    };
  }

  if (Object.keys(conflicts).length === 0) return false;

  await audit.writeConflict({
    person_id: personId,
    conflicting_evidence: conflicts,
    status: 'pending_review',
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
  });

  return true;
}
