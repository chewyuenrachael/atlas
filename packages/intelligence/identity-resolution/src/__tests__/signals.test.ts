/**
 * Unit tests for each signal extractor in `signals.ts`.
 *
 * Strategy: build a minimal `PersonWithContext` candidate per test, vary
 * the new-record payload, and assert which signal (if any) is emitted and
 * with what `weight`/`confidence`.
 *
 * Spec ref: SPEC.md §4.2.
 */
import { describe, expect, it } from 'vitest';

import { RESOLUTION_SIGNAL_WEIGHTS, type Person, type PersonPlatformIdentity } from '@atlas/core';

import {
  extractAllSignals,
  extractCityMatch,
  extractEmailDomainWithNameMatch,
  extractEmailExact,
  extractEmployerMatch,
  extractEventCoAttendance,
  extractGithubLinkInBio,
  extractLinkedinLinkInBio,
  extractMutualConnection,
  extractNameExact,
  extractNameFuzzy,
  extractTimezoneOverlap,
  extractTwitterLinkInBio,
} from '../signals.js';
import type { PersonWithContext } from '../store.js';
import type { NormalizedPersonPayload } from '../types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'p-test',
    canonical_name: 'Alice Chen',
    names_seen: ['Alice Chen'],
    emails_seen: [],
    primary_email: null,
    location_city: null,
    location_country: null,
    location_timezone: null,
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
    first_observed_at: '2025-01-01T00:00:00.000Z',
    last_observed_at: '2025-01-01T00:00:00.000Z',
    is_active: true,
    metadata: {},
    ...overrides,
  };
}

function makeCandidate(
  person: Partial<Person> = {},
  ctx: Partial<Omit<PersonWithContext, 'person'>> = {},
): PersonWithContext {
  const p = makePerson(person);
  return {
    person: p,
    platformIdentities: ctx.platformIdentities ?? [],
    eventIds: ctx.eventIds ?? [],
    connectedPersonIds: ctx.connectedPersonIds ?? [],
    currentEmployerCompanyId: p.employer_company_id,
  };
}

function ppi(
  personId: string,
  platform: PersonPlatformIdentity['platform'],
  handle: string,
): PersonPlatformIdentity {
  return {
    id: `ppi-${personId}-${platform}`,
    person_id: personId,
    platform,
    handle,
    platform_user_id: null,
    profile_url: null,
    follower_count: null,
    verified: false,
    observed_at: '2025-01-01T00:00:00.000Z',
    resolution_confidence: 1,
    resolution_method: 'self_reported',
  };
}

// ---------------------------------------------------------------------------
// name_exact
// ---------------------------------------------------------------------------

describe('extractNameExact', () => {
  it('matches identical names case- and whitespace-insensitively', () => {
    const candidate = makeCandidate({ canonical_name: 'Alice Chen' });
    const record: NormalizedPersonPayload = { canonicalName: '  alice CHEN ' };
    const s = extractNameExact(record, candidate);
    expect(s).toEqual({
      signalType: 'name_exact',
      weight: RESOLUTION_SIGNAL_WEIGHTS.name_exact,
      confidence: 1,
    });
  });

  it('matches against names_seen array, not just canonical_name', () => {
    const candidate = makeCandidate({
      canonical_name: 'Alice Chen',
      names_seen: ['Alice Chen', 'Alice C.'],
    });
    const s = extractNameExact({ canonicalName: 'Alice C.' }, candidate);
    expect(s?.signalType).toBe('name_exact');
  });

  it('strips diacritics before comparing', () => {
    const candidate = makeCandidate({ canonical_name: 'Álvaro García' });
    const s = extractNameExact({ canonicalName: 'Alvaro Garcia' }, candidate);
    expect(s?.signalType).toBe('name_exact');
  });

  it('returns null when names differ', () => {
    const candidate = makeCandidate({ canonical_name: 'Alice Chen' });
    expect(extractNameExact({ canonicalName: 'Bob Smith' }, candidate)).toBeNull();
  });

  it('returns null when either side has no name', () => {
    const candidate = makeCandidate({ canonical_name: '', names_seen: [] });
    expect(extractNameExact({ canonicalName: 'Alice Chen' }, candidate)).toBeNull();
    expect(extractNameExact({}, makeCandidate())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// name_fuzzy
// ---------------------------------------------------------------------------

describe('extractNameFuzzy', () => {
  it('emits a signal above the JW threshold', () => {
    const candidate = makeCandidate({ canonical_name: 'Alexander Martinez' });
    const s = extractNameFuzzy({ canonicalName: 'Alex Martinez' }, candidate);
    expect(s?.signalType).toBe('name_fuzzy');
    expect(s!.weight).toBe(RESOLUTION_SIGNAL_WEIGHTS.name_fuzzy);
    expect(s!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('returns null below the JW threshold', () => {
    const candidate = makeCandidate({ canonical_name: 'Alice Chen' });
    expect(extractNameFuzzy({ canonicalName: 'Bob Smith' }, candidate)).toBeNull();
  });

  it('does not double-count when name_exact also matches', () => {
    const candidate = makeCandidate({ canonical_name: 'Alice Chen' });
    expect(extractNameFuzzy({ canonicalName: 'Alice Chen' }, candidate)).toBeNull();
  });

  it('returns higher confidence for closer matches', () => {
    const candidate = makeCandidate({ canonical_name: 'Yui Kobayashi' });
    const close = extractNameFuzzy({ canonicalName: 'Yuki Kobayashi' }, candidate);
    const looser = extractNameFuzzy(
      { canonicalName: 'Kenji Tanaka' },
      makeCandidate({ canonical_name: 'Kenji Takeda' }),
    );
    expect(close).not.toBeNull();
    expect(looser).not.toBeNull();
    expect(close!.confidence).toBeGreaterThanOrEqual(looser!.confidence);
  });
});

// ---------------------------------------------------------------------------
// email_exact
// ---------------------------------------------------------------------------

describe('extractEmailExact', () => {
  it('matches an email present on either side', () => {
    const candidate = makeCandidate({
      emails_seen: ['alice.chen@jpmorgan.com'],
      primary_email: 'alice.chen@jpmorgan.com',
    });
    const s = extractEmailExact({ emails: ['Alice.Chen@JPMorgan.com'] }, candidate);
    expect(s).toEqual({
      signalType: 'email_exact',
      weight: RESOLUTION_SIGNAL_WEIGHTS.email_exact,
      confidence: 1,
    });
  });

  it('returns null when no emails overlap', () => {
    const candidate = makeCandidate({ emails_seen: ['a@b.com'] });
    expect(extractEmailExact({ emails: ['c@d.com'] }, candidate)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// email_domain (paired with name match)
// ---------------------------------------------------------------------------

describe('extractEmailDomainWithNameMatch', () => {
  it('fires only when domain matches AND name corroborates', () => {
    const candidate = makeCandidate({
      canonical_name: 'Dmitri Ivanov',
      emails_seen: ['di@acme.io'],
    });
    const s = extractEmailDomainWithNameMatch(
      { canonicalName: 'Dmitri Ivanov', emails: ['dmitri@acme.io'] },
      candidate,
    );
    expect(s?.signalType).toBe('email_domain');
  });

  it('skips free-mail domains (gmail, hotmail, etc.)', () => {
    const candidate = makeCandidate({
      canonical_name: 'Bob Williams',
      emails_seen: ['bob@gmail.com'],
    });
    const s = extractEmailDomainWithNameMatch(
      { canonicalName: 'Bob Williams', emails: ['robert@gmail.com'] },
      candidate,
    );
    expect(s).toBeNull();
  });

  it('does not fire when the name does not corroborate', () => {
    const candidate = makeCandidate({
      canonical_name: 'Alice Chen',
      emails_seen: ['alice@stripe.com'],
    });
    const s = extractEmailDomainWithNameMatch(
      { canonicalName: 'Bob Smith', emails: ['bob@stripe.com'] },
      candidate,
    );
    expect(s).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bio link signals
// ---------------------------------------------------------------------------

describe('extract<Platform>LinkInBio', () => {
  it('github_link_in_bio matches when handle exists on candidate', () => {
    const candidate = makeCandidate(
      {},
      {
        platformIdentities: [ppi('p-test', 'github', 'octocat')],
      },
    );
    const s = extractGithubLinkInBio({ bioLinks: { github: '@OctoCat' } }, candidate);
    expect(s?.signalType).toBe('github_link_in_bio');
    expect(s?.weight).toBe(RESOLUTION_SIGNAL_WEIGHTS.github_link_in_bio);
  });

  it('twitter_link_in_bio fires for twitter platform identities only', () => {
    const candidate = makeCandidate(
      {},
      {
        platformIdentities: [ppi('p-test', 'twitter', 'jane_doe')],
      },
    );
    expect(
      extractTwitterLinkInBio({ bioLinks: { twitter: 'jane_doe' } }, candidate),
    ).not.toBeNull();
    expect(extractGithubLinkInBio({ bioLinks: { twitter: 'jane_doe' } }, candidate)).toBeNull();
  });

  it('linkedin_link_in_bio matches', () => {
    const candidate = makeCandidate(
      {},
      {
        platformIdentities: [ppi('p-test', 'linkedin', 'maria-garcia')],
      },
    );
    expect(
      extractLinkedinLinkInBio({ bioLinks: { linkedin: 'maria-garcia' } }, candidate),
    ).not.toBeNull();
  });

  it('returns null when the candidate has no identity for that platform', () => {
    const candidate = makeCandidate();
    expect(extractGithubLinkInBio({ bioLinks: { github: 'octocat' } }, candidate)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// employer / city / timezone / mutual_connection / event_co_attendance
// ---------------------------------------------------------------------------

describe('extractEmployerMatch', () => {
  it('fires when both sides resolve to the same Company', () => {
    const candidate = makeCandidate({ employer_company_id: 'comp-stripe' });
    const s = extractEmployerMatch({ employerCompanyId: 'comp-stripe' }, candidate);
    expect(s?.signalType).toBe('employer_match');
  });

  it('does not fire when employer ids differ', () => {
    const candidate = makeCandidate({ employer_company_id: 'comp-a' });
    expect(extractEmployerMatch({ employerCompanyId: 'comp-b' }, candidate)).toBeNull();
  });

  it('does not fire when either side is missing', () => {
    expect(extractEmployerMatch({}, makeCandidate({ employer_company_id: 'comp-a' }))).toBeNull();
    expect(extractEmployerMatch({ employerCompanyId: 'comp-a' }, makeCandidate())).toBeNull();
  });
});

describe('extractCityMatch', () => {
  it('matches identical cities (case-insensitive)', () => {
    const candidate = makeCandidate({
      location_city: 'San Francisco',
      location_country: 'United States',
    });
    const s = extractCityMatch({ city: 'san francisco', country: 'United States' }, candidate);
    expect(s?.signalType).toBe('city_match');
  });

  it('suppresses match when countries disagree (Springfield problem)', () => {
    const candidate = makeCandidate({
      location_city: 'Springfield',
      location_country: 'United States',
    });
    expect(
      extractCityMatch({ city: 'Springfield', country: 'United Kingdom' }, candidate),
    ).toBeNull();
  });

  it('returns null when one side lacks a city', () => {
    const candidate = makeCandidate({ location_city: null });
    expect(extractCityMatch({ city: 'Tokyo' }, candidate)).toBeNull();
  });
});

describe('extractTimezoneOverlap', () => {
  it('matches identical IANA timezones', () => {
    const candidate = makeCandidate({ location_timezone: 'Europe/London' });
    const s = extractTimezoneOverlap({ timezone: 'Europe/London' }, candidate);
    expect(s?.signalType).toBe('timezone_overlap');
    expect(s?.confidence).toBe(1);
  });

  it('returns partial overlap for same continent', () => {
    const candidate = makeCandidate({ location_timezone: 'America/Los_Angeles' });
    const s = extractTimezoneOverlap({ timezone: 'America/Vancouver' }, candidate);
    expect(s?.signalType).toBe('timezone_overlap');
    expect(s?.confidence).toBeLessThan(1);
  });

  it('returns null when neither continent nor full tz matches', () => {
    const candidate = makeCandidate({ location_timezone: 'America/Los_Angeles' });
    expect(extractTimezoneOverlap({ timezone: 'Asia/Tokyo' }, candidate)).toBeNull();
  });
});

describe('extractMutualConnection', () => {
  it('emits a signal when records share at least one connection', () => {
    const candidate = makeCandidate({}, { connectedPersonIds: ['p-1', 'p-2'] });
    const s = extractMutualConnection({ connectedPersonIds: ['p-2', 'p-3'] }, candidate);
    expect(s?.signalType).toBe('mutual_connection');
  });

  it('returns null when no edges exist on either side', () => {
    expect(extractMutualConnection({}, makeCandidate({}, { connectedPersonIds: [] }))).toBeNull();
    expect(
      extractMutualConnection(
        { connectedPersonIds: ['p-1'] },
        makeCandidate({}, { connectedPersonIds: [] }),
      ),
    ).toBeNull();
  });
});

describe('extractEventCoAttendance', () => {
  it('emits when both reference the same event', () => {
    const candidate = makeCandidate({}, { eventIds: ['evt-1', 'evt-2'] });
    const s = extractEventCoAttendance({ eventIds: ['evt-2'] }, candidate);
    expect(s?.signalType).toBe('event_co_attendance');
  });

  it('returns null when no overlap', () => {
    const candidate = makeCandidate({}, { eventIds: ['evt-1'] });
    expect(extractEventCoAttendance({ eventIds: ['evt-9'] }, candidate)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAllSignals — aggregation
// ---------------------------------------------------------------------------

describe('extractAllSignals', () => {
  it('returns every fired extractor for a strong-corroborating record', () => {
    const candidate = makeCandidate(
      {
        canonical_name: 'Alice Chen',
        emails_seen: ['alice@stripe.com'],
        location_city: 'San Francisco',
        location_country: 'United States',
        location_timezone: 'America/Los_Angeles',
        employer_company_id: 'comp-stripe',
      },
      { platformIdentities: [ppi('p-test', 'github', 'alice_codes')] },
    );
    const signals = extractAllSignals(
      {
        canonicalName: 'Alice Chen',
        emails: ['alice.dev@stripe.com'],
        city: 'San Francisco',
        country: 'United States',
        timezone: 'America/Los_Angeles',
        employerCompanyId: 'comp-stripe',
        bioLinks: { github: 'alice_codes' },
      },
      candidate,
    );
    const types = signals.map((s) => s.signalType).sort();
    expect(types).toEqual(
      [
        'city_match',
        'email_domain',
        'employer_match',
        'github_link_in_bio',
        'name_exact',
        'timezone_overlap',
      ].sort(),
    );
  });

  it('returns empty array when nothing matches', () => {
    expect(extractAllSignals({ canonicalName: 'No Match' }, makeCandidate())).toEqual([]);
  });
});
