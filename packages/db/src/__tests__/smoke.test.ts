/**
 * Smoke test: bootstrap a Company → Person → PlatformIdentity → Event →
 * PersonEvent graph, query everything back, verify referential integrity,
 * and clean up.
 *
 * Runs against the real Supabase database referenced by `DATABASE_URL` and
 * `SUPABASE_*` env vars. Guarded by `RUN_SMOKE_TESTS=1` so `pnpm test`
 * doesn't accidentally hit a remote DB. Invoke via `pnpm db:smoke`.
 *
 * SPEC ref: §3.2 (entities), §3.3.1 (person_event), §3.3.2 (person_company).
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  CompanyQueries,
  EventQueries,
  PersonQueries,
  __resetClientsForTesting,
  getServiceClient,
} from '../index.js';

const shouldRun = process.env['RUN_SMOKE_TESTS'] === '1';

describe.skipIf(!shouldRun)('db smoke test', () => {
  // Suffix tags the run so concurrent invocations don't collide on unique keys.
  const suffix = `smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let companyId: string | undefined;
  let personId: string | undefined;
  let eventId: string | undefined;

  afterAll(async () => {
    // Best-effort cleanup in reverse FK dependency order.
    const svc = getServiceClient();
    if (!svc.ok) return;
    const sb = svc.value;
    if (eventId) await sb.from('event').delete().eq('id', eventId);
    if (personId) {
      await sb.from('person_platform_identity').delete().eq('person_id', personId);
      await sb.from('person_company').delete().eq('person_id', personId);
      await sb.from('person').delete().eq('id', personId);
    }
    if (companyId) await sb.from('company').delete().eq('id', companyId);
    __resetClientsForTesting();
  });

  it('creates a Company', async () => {
    const result = await CompanyQueries.createCompany({
      canonical_name: `Acme Corp ${suffix}`,
      domain: `${suffix}.example.com`,
      aliases: [`acme-${suffix}`],
      vertical: 'tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    companyId = result.value.id;
    expect(result.value.canonical_name).toContain('Acme Corp');
    expect(result.value.first_observed_at).toBeTruthy();
  });

  it('creates a Person linked to that Company', async () => {
    if (!companyId) throw new Error('companyId missing');
    const result = await PersonQueries.createPerson({
      canonical_name: `Alice Chen ${suffix}`,
      primary_email: `alice-${suffix}@example.com`,
      emails_seen: [`alice-${suffix}@example.com`],
      location_city: 'Lagos',
      location_country: 'Nigeria',
      employer_company_id: companyId,
      employer_seen_at: new Date().toISOString(),
      lifecycle_stage: 'engaged',
      activity_score: 42,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    personId = result.value.id;
    expect(result.value.employer_company_id).toBe(companyId);
    expect(result.value.lifecycle_stage).toBe('engaged');

    // Also write the person_company edge (employer_company_id alone is
    // denormalized; the canonical employment record lives in person_company).
    const svc = getServiceClient();
    if (!svc.ok) throw svc.error;
    const pc = await svc.value.from('person_company').insert({
      person_id: personId,
      company_id: companyId,
      role: 'Senior Engineer',
      seniority: 'senior',
      is_current: true,
      source: 'luma_form',
      confidence: 0.9,
    });
    expect(pc.error).toBeNull();
  });

  it('attaches a twitter platform identity', async () => {
    if (!personId) throw new Error('personId missing');
    const result = await PersonQueries.addPlatformIdentity(personId, {
      person_id: personId,
      platform: 'twitter',
      handle: `alicebuilds-${suffix}`,
      platform_user_id: `tw-${suffix}`,
      profile_url: `https://x.com/alicebuilds-${suffix}`,
      follower_count: 4200,
      verified: false,
      resolution_confidence: 1.0,
      resolution_method: 'self_reported',
    });
    expect(result.ok).toBe(true);
  });

  it('inserts an Event', async () => {
    const result = await EventQueries.createEvent({
      title: `Café Cursor Lagos ${suffix}`,
      starts_at: new Date(Date.now() + 86_400_000).toISOString(),
      venue_city: 'Lagos',
      venue_country: 'Nigeria',
      event_format: 'in_person',
      program_type: 'cafe_cursor',
      status: 'scheduled',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    eventId = result.value.id;
    expect(result.value.venue_city).toBe('Lagos');
  });

  it('records person attendance at the event', async () => {
    if (!personId || !eventId) throw new Error('preconditions missing');
    const result = await EventQueries.recordAttendance({
      person_id: personId,
      event_id: eventId,
      role: 'attendee',
      registered_at: new Date().toISOString(),
      attended_at: null,
      luma_role_raw: 'registered',
      post_event_sentiment: null,
      post_event_feedback: null,
    });
    expect(result.ok).toBe(true);
  });

  it('queries the graph back end-to-end', async () => {
    if (!personId || !companyId || !eventId) throw new Error('preconditions missing');

    const company = await CompanyQueries.getCompanyById(companyId);
    expect(company.ok).toBe(true);
    if (company.ok) expect(company.value?.id).toBe(companyId);

    const personById = await PersonQueries.getPersonById(personId);
    expect(personById.ok).toBe(true);
    if (personById.ok) expect(personById.value?.employer_company_id).toBe(companyId);

    const peopleByEmployer = await PersonQueries.findPersonsByEmployer(companyId);
    expect(peopleByEmployer.ok).toBe(true);
    if (peopleByEmployer.ok)
      expect(peopleByEmployer.value.some((p) => p.id === personId)).toBe(true);

    const peopleByHandle = await PersonQueries.findPersonsByPlatformHandle(
      'twitter',
      `alicebuilds-${suffix}`,
    );
    expect(peopleByHandle.ok).toBe(true);
    if (peopleByHandle.ok) expect(peopleByHandle.value.map((p) => p.id)).toContain(personId);

    const attendees = await EventQueries.getEventAttendees(eventId);
    expect(attendees.ok).toBe(true);
    if (attendees.ok) {
      expect(attendees.value.length).toBeGreaterThanOrEqual(1);
      expect(attendees.value.some((a) => a.person.id === personId)).toBe(true);
    }
  });

  it('enforces referential integrity on edges', async () => {
    const svc = getServiceClient();
    if (!svc.ok) throw svc.error;
    const bogus = '00000000-0000-0000-0000-000000000000';
    const violation = await svc.value
      .from('person_event')
      .insert({ person_id: bogus, event_id: bogus, role: 'attendee' });
    expect(violation.error).not.toBeNull();
    expect(violation.error?.code).toBe('23503');
  });
});
