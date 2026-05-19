/**
 * End-to-end resolver tests against `InMemoryPersonStore`.
 *
 * The same in-memory store implements both `PersonStore` and
 * `ResolutionAuditStore`, so we can inspect Persons, platform identities,
 * resolution_decision rows, conflict rows, and the review queue after each
 * `resolver.resolve(...)` call.
 *
 * Spec ref: SPEC.md §4.2, §4.3, §4.4, §4.5.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { isErr, isOk } from '@atlas/core';

import { IdentityResolver } from '../resolver.js';
import { decideAction } from '../decision.js';
import { detectConflict } from '../conflicts.js';
import {
  ALL_FIXTURES,
  ambiguousReviewCandidates,
  trueNegativeNewPersons,
  truePositiveMerges,
  type ResolutionFixture,
} from '../__fixtures__/index.js';
import { InMemoryPersonStore } from '../store.js';

beforeEach(() => {
  InMemoryPersonStore.resetIdCounter();
});

function buildStore(fixture: ResolutionFixture): InMemoryPersonStore {
  const store = new InMemoryPersonStore();
  for (const seed of fixture.seeded) {
    store.seedPerson(seed);
  }
  return store;
}

describe('IdentityResolver — Tier 1 (explicit linking)', () => {
  it('merges on exact email match with confidence 1.0', async () => {
    const fixture = truePositiveMerges.find((f) => f.id === 'M-EMAIL-EXACT')!;
    const store = buildStore(fixture);
    const resolver = new IdentityResolver({ store, audit: store });

    const result = await resolver.resolve(fixture.record);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.action).toBe('merge');
    expect(result.value.personId).toBe(fixture.expected.matchedPersonId);
    expect(result.value.confidence).toBe(1);
    expect(result.value.reasoning).toMatch(/tier1: email_exact/);

    // Decision audit row present
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]).toMatchObject({
      action: 'merge',
      matched_person_id: fixture.expected.matchedPersonId,
      decided_by: 'system',
    });
  });

  it('merges on exact platform+handle match with confidence 1.0', async () => {
    const fixture = truePositiveMerges.find((f) => f.id === 'M-PLATFORM-HANDLE-EXACT')!;
    const store = buildStore(fixture);
    const resolver = new IdentityResolver({ store, audit: store });

    const result = await resolver.resolve(fixture.record);
    if (!isOk(result)) throw new Error('expected ok');

    expect(result.value.action).toBe('merge');
    expect(result.value.confidence).toBe(1);
    expect(result.value.reasoning).toMatch(/tier1: platform_handle_exact/);
  });

  it('still merges (Tier 1) even when names differ if emails match exactly', async () => {
    const fixture = truePositiveMerges.find((f) => f.id === 'M-EMAIL-EXACT-CROSS-SOURCE')!;
    const store = buildStore(fixture);
    const resolver = new IdentityResolver({ store, audit: store });

    const result = await resolver.resolve(fixture.record);
    if (!isOk(result)) throw new Error('expected ok');

    expect(result.value.action).toBe('merge');
    expect(result.value.personId).toBe(fixture.expected.matchedPersonId);
    // The new platform identity should now be attached.
    const ctx = await store.getById(fixture.expected.matchedPersonId!);
    expect(ctx?.platformIdentities.map((p) => p.platform)).toContain('github');
  });
});

describe('IdentityResolver — Tier 2 (heuristic)', () => {
  it('merges on strong multi-signal corroboration', async () => {
    const fixture = truePositiveMerges.find((f) => f.id === 'M-MULTI-SIGNAL-STRONG')!;
    const store = buildStore(fixture);
    const resolver = new IdentityResolver({ store, audit: store });

    const result = await resolver.resolve(fixture.record);
    if (!isOk(result)) throw new Error('expected ok');

    expect(result.value.action).toBe('merge');
    expect(result.value.personId).toBe(fixture.expected.matchedPersonId);
    expect(result.value.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.value.signals.length).toBeGreaterThan(1);
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]?.action).toBe('merge');
  });

  it('routes a borderline-fuzzy single-signal match to human_review', async () => {
    const fixture = ambiguousReviewCandidates.find((f) => f.id === 'A-FUZZY-NAME-ALONE')!;
    const store = buildStore(fixture);
    const resolver = new IdentityResolver({ store, audit: store });

    const result = await resolver.resolve(fixture.record);
    if (!isOk(result)) throw new Error('expected ok');

    expect(result.value.action).toBe('human_review');
    expect(result.value.confidence).toBeGreaterThanOrEqual(0.65);
    expect(result.value.confidence).toBeLessThan(0.85);
    expect(result.value.personId).toBeNull();

    // Review queue + decision row both present, no Person mutated.
    expect(store.reviewQueue).toHaveLength(1);
    expect(store.reviewQueue[0]?.itemType).toBe('identity_resolution_review');
    expect(store.decisions[0]?.action).toBe('human_review');
  });

  it('creates a new Person when no candidates exist', async () => {
    const fixture = trueNegativeNewPersons.find((f) => f.id === 'N-TOTALLY-DIFFERENT')!;
    const store = buildStore(fixture);
    const seededCount = store.size();
    const resolver = new IdentityResolver({ store, audit: store });

    const result = await resolver.resolve(fixture.record);
    if (!isOk(result)) throw new Error('expected ok');

    expect(result.value.action).toBe('create_new');
    expect(result.value.personId).not.toBeNull();
    expect(store.size()).toBe(seededCount + 1);
    expect(store.decisions[0]?.action).toBe('create_new');
  });

  it('writes a resolution_decision row on EVERY code path', async () => {
    for (const fixture of ALL_FIXTURES) {
      const store = buildStore(fixture);
      const resolver = new IdentityResolver({ store, audit: store });
      const result = await resolver.resolve(fixture.record);
      expect(isOk(result)).toBe(true);
      expect(store.decisions, fixture.id).toHaveLength(1);
    }
  });
});

describe('IdentityResolver — conflict detection', () => {
  it('records a resolution_conflict row when employer disagrees but merge proceeds', async () => {
    const store = new InMemoryPersonStore();
    const personId = store.seedPerson({
      id: 'p-conflict-1',
      canonical_name: 'Bob Robertson',
      emails_seen: ['bob@oldco.com'],
      primary_email: 'bob@oldco.com',
      location_city: 'London',
      employer_company_id: 'comp-oldco',
    });
    const resolver = new IdentityResolver({ store, audit: store });

    const result = await resolver.resolve({
      recordType: 'person',
      sourcePlatform: 'linkedin',
      sourceRecordId: 'li-bob-1',
      observedAt: '2025-05-01T00:00:00.000Z',
      payload: {
        canonicalName: 'Bob Robertson',
        emails: ['bob@oldco.com'],
        city: 'London',
        employerCompanyId: 'comp-newco',
        employerObservedAt: '2025-05-01T00:00:00.000Z',
      },
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.action).toBe('merge');
    expect(result.value.personId).toBe(personId);
    expect(result.value.conflictDetected).toBe(true);
    expect(store.conflicts).toHaveLength(1);
    expect(store.conflicts[0]?.conflicting_evidence).toMatchObject({
      employer: { existing_company_id: 'comp-oldco', new_company_id: 'comp-newco' },
    });
  });

  it('detectConflict returns false when nothing disagrees', async () => {
    const store = new InMemoryPersonStore();
    const personId = store.seedPerson({
      id: 'p-conflict-2',
      canonical_name: 'Alice Chen',
      employer_company_id: 'comp-a',
    });
    const result = await detectConflict(personId, { employerCompanyId: 'comp-a' }, store, store);
    expect(result).toBe(false);
    expect(store.conflicts).toHaveLength(0);
  });
});

describe('IdentityResolver — fixture accuracy', () => {
  it('classifies >=95% of known fixtures correctly', async () => {
    let correct = 0;
    const wrong: Array<{ id: string; expected: string; actual: string; confidence: number }> = [];

    for (const fixture of ALL_FIXTURES) {
      const store = buildStore(fixture);
      const resolver = new IdentityResolver({ store, audit: store });
      const result = await resolver.resolve(fixture.record);
      if (!isOk(result)) {
        wrong.push({
          id: fixture.id,
          expected: fixture.expected.action,
          actual: 'error',
          confidence: 0,
        });
        continue;
      }
      const actual = result.value.action;
      const expected = fixture.expected.action;
      const matchedExpected =
        !fixture.expected.matchedPersonId ||
        result.value.personId === fixture.expected.matchedPersonId;
      if (actual === expected && matchedExpected) {
        correct += 1;
      } else {
        wrong.push({
          id: fixture.id,
          expected,
          actual,
          confidence: result.value.confidence,
        });
      }
    }

    const accuracy = correct / ALL_FIXTURES.length;
    // Per the task brief: ≥95% accuracy on the labelled fixtures.
    expect(
      accuracy,
      `accuracy=${accuracy.toFixed(3)}, wrong=${JSON.stringify(wrong, null, 2)}`,
    ).toBeGreaterThanOrEqual(0.95);
  });
});

describe('IdentityResolver — invalid inputs', () => {
  it('returns an Err when handed a non-person record', async () => {
    const store = new InMemoryPersonStore();
    const resolver = new IdentityResolver({ store, audit: store });
    const result = await resolver.resolve({
      recordType: 'event',
      sourcePlatform: 'luma',
      sourceRecordId: 'evt-1',
      payload: {},
      observedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(isErr(result)).toBe(true);
  });
});

describe('decideAction', () => {
  it('returns merge at and above 0.85', () => {
    expect(decideAction(0.85, 1)).toBe('merge');
    expect(decideAction(0.99, 1)).toBe('merge');
  });

  it('returns human_review in [0.65, 0.85)', () => {
    expect(decideAction(0.65, 1)).toBe('human_review');
    expect(decideAction(0.849, 1)).toBe('human_review');
  });

  it('returns create_new below 0.65 with no candidates', () => {
    expect(decideAction(0.5, 0)).toBe('create_new');
    expect(decideAction(0, 0)).toBe('create_new');
  });

  it('returns skip below 0.65 when candidates exist', () => {
    expect(decideAction(0.5, 3)).toBe('skip');
    expect(decideAction(0.0, 1)).toBe('skip');
  });
});
