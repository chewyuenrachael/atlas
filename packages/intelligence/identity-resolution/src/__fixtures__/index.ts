/**
 * Ground-truth fixtures for identity resolution tests + calibration.
 *
 * Each fixture seeds zero or more existing Persons, presents one new
 * `NormalizedRecord<NormalizedPersonPayload>` to the resolver, and asserts
 * an expected `ResolutionAction`. When the expectation is `merge`, the
 * fixture also names which seeded person the new record should attach to.
 *
 * Three buckets, mirroring the task brief:
 *   - `truePositiveMerges` — 10 paired records that genuinely refer to the
 *     same human and should auto-merge.
 *   - `trueNegativeNewPersons` — 10 records that refer to a different
 *     human than any seeded candidate and should land as `create_new`
 *     (or `skip` when a low-confidence candidate exists; see notes below).
 *   - `ambiguousReviewCandidates` — 5 records that should fall into the
 *     human-review band 0.65 ≤ confidence < 0.85.
 *
 * Spec ref: SPEC.md §4.2 (thresholds), §4.3 (workflow).
 */
import type { IsoTimestamp, PersonPlatformIdentity, UUID } from '@atlas/core';

import type { NormalizedPersonRecord } from '../types.js';

const OBSERVED_AT: IsoTimestamp = '2025-04-15T12:00:00.000Z';
const SEEDED_AT: IsoTimestamp = '2025-01-01T00:00:00.000Z';

/** Minimal SeedPerson — duplicated locally so fixtures stay framework-free. */
export interface SeedPersonInput {
  id: UUID;
  canonical_name: string;
  names_seen?: string[];
  emails_seen?: string[];
  primary_email?: string | null;
  location_city?: string | null;
  location_country?: string | null;
  location_timezone?: string | null;
  employer_company_id?: UUID | null;
  platformIdentities?: PersonPlatformIdentity[];
  eventIds?: UUID[];
  connectedPersonIds?: UUID[];
}

/** A single fixture row. */
export interface ResolutionFixture {
  id: string;
  description: string;
  seeded: SeedPersonInput[];
  record: NormalizedPersonRecord;
  /** Expected resolver decision under the ground-truth labelling. */
  expected: {
    action: 'merge' | 'create_new' | 'human_review' | 'skip';
    /** When `action === 'merge'`, which seeded person should win. */
    matchedPersonId?: UUID;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ppi(
  personId: UUID,
  platform: PersonPlatformIdentity['platform'],
  handle: string,
  followers: number = 0,
): PersonPlatformIdentity {
  return {
    id: `seed-ppi-${personId}-${platform}`,
    person_id: personId,
    platform,
    handle,
    platform_user_id: null,
    profile_url: null,
    follower_count: followers,
    verified: false,
    observed_at: SEEDED_AT,
    resolution_confidence: 1,
    resolution_method: 'self_reported',
  };
}

function lumaRecord(
  sourceRecordId: string,
  payload: NormalizedPersonRecord['payload'],
): NormalizedPersonRecord {
  return {
    recordType: 'person',
    sourcePlatform: 'luma',
    sourceRecordId,
    payload,
    observedAt: OBSERVED_AT,
  };
}

function githubRecord(
  sourceRecordId: string,
  payload: NormalizedPersonRecord['payload'],
): NormalizedPersonRecord {
  return {
    recordType: 'person',
    sourcePlatform: 'github',
    sourceRecordId,
    payload,
    observedAt: OBSERVED_AT,
  };
}

function twitterRecord(
  sourceRecordId: string,
  payload: NormalizedPersonRecord['payload'],
): NormalizedPersonRecord {
  return {
    recordType: 'person',
    sourcePlatform: 'twitter',
    sourceRecordId,
    payload,
    observedAt: OBSERVED_AT,
  };
}

function forumRecord(
  sourceRecordId: string,
  payload: NormalizedPersonRecord['payload'],
): NormalizedPersonRecord {
  return {
    recordType: 'person',
    sourcePlatform: 'forum',
    sourceRecordId,
    payload,
    observedAt: OBSERVED_AT,
  };
}

// ---------------------------------------------------------------------------
// 10 paired records that SHOULD merge
// ---------------------------------------------------------------------------

export const truePositiveMerges: ResolutionFixture[] = [
  {
    id: 'M-EMAIL-EXACT',
    description: 'Same email exact (Tier 1 explicit link)',
    seeded: [
      {
        id: 'p-tp-001',
        canonical_name: 'Alice Chen',
        emails_seen: ['alice.chen@jpmorgan.com'],
        primary_email: 'alice.chen@jpmorgan.com',
        location_city: 'New York',
        location_country: 'United States',
      },
    ],
    record: lumaRecord('luma-evt-001:att-9', {
      canonicalName: 'Alice Chen',
      primaryEmail: 'alice.chen@jpmorgan.com',
      city: 'New York',
      country: 'United States',
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-001' },
  },

  {
    id: 'M-EMAIL-EXACT-CROSS-SOURCE',
    description: 'Different name on a different source but same exact email (Tier 1)',
    seeded: [
      {
        id: 'p-tp-002',
        canonical_name: 'Alice Chen',
        names_seen: ['Alice Chen'],
        emails_seen: ['alice@personal.dev'],
        primary_email: 'alice@personal.dev',
      },
    ],
    record: githubRecord('gh-user-12345', {
      canonicalName: 'alice_codes',
      namesSeen: ['alice_codes'],
      emails: ['alice@personal.dev'],
      platformIdentity: {
        platform: 'github',
        handle: 'alice_codes',
        platformUserId: '12345',
      },
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-002' },
  },

  {
    id: 'M-PLATFORM-HANDLE-EXACT',
    description: 'Same platform + handle exact (Tier 1 explicit link)',
    seeded: [
      {
        id: 'p-tp-003',
        canonical_name: 'Bob Rivera',
        platformIdentities: [ppi('p-tp-003', 'github', 'bob_rivera')],
      },
    ],
    record: githubRecord('gh-user-99', {
      canonicalName: 'Bob Rivera',
      platformIdentity: {
        platform: 'github',
        handle: 'bob_rivera',
        platformUserId: '99',
      },
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-003' },
  },

  {
    id: 'M-GITHUB-BIO-LINK',
    description: 'Luma attendee links to existing github handle in bio',
    seeded: [
      {
        id: 'p-tp-004',
        canonical_name: 'Octavia Cat',
        names_seen: ['Octavia Cat'],
        platformIdentities: [ppi('p-tp-004', 'github', 'octocat', 12000)],
      },
    ],
    record: lumaRecord('luma-evt-007:att-21', {
      canonicalName: 'Octavia Cat',
      bioLinks: { github: 'octocat' },
      city: 'San Francisco',
      country: 'United States',
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-004' },
  },

  {
    id: 'M-TWITTER-BIO-LINK',
    description: 'Forum post author links to existing twitter handle',
    seeded: [
      {
        id: 'p-tp-005',
        canonical_name: 'Jane Doe',
        platformIdentities: [ppi('p-tp-005', 'twitter', 'jane_doe', 4500)],
      },
    ],
    record: forumRecord('forum-post-1142', {
      canonicalName: 'Jane Doe',
      bioLinks: { twitter: 'jane_doe' },
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-005' },
  },

  {
    id: 'M-LINKEDIN-BIO-LINK',
    description: 'Linkedin handle resolved from luma "linkedin_url" field',
    seeded: [
      {
        id: 'p-tp-006',
        canonical_name: 'Maria Garcia',
        platformIdentities: [ppi('p-tp-006', 'linkedin', 'maria-garcia-acme')],
      },
    ],
    record: lumaRecord('luma-evt-014:att-3', {
      canonicalName: 'Maria Garcia',
      bioLinks: { linkedin: 'maria-garcia-acme' },
      city: 'Madrid',
      country: 'Spain',
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-006' },
  },

  {
    id: 'M-MULTI-SIGNAL-STRONG',
    description: 'Name exact + same employer + same city (Tier 2 strong)',
    seeded: [
      {
        id: 'p-tp-007',
        canonical_name: 'Bob Robertson',
        location_city: 'London',
        location_country: 'United Kingdom',
        location_timezone: 'Europe/London',
        employer_company_id: 'comp-jpm',
      },
    ],
    record: lumaRecord('luma-evt-009:att-2', {
      canonicalName: 'Bob Robertson',
      employerCompanyId: 'comp-jpm',
      city: 'London',
      country: 'United Kingdom',
      timezone: 'Europe/London',
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-007' },
  },

  {
    id: 'M-NAME-EXACT-EMAIL-DOMAIN',
    description: 'Name exact + same non-free email domain (different local parts)',
    seeded: [
      {
        id: 'p-tp-008',
        canonical_name: 'Dmitri Ivanov',
        emails_seen: ['dmitri@acme.io'],
        primary_email: 'dmitri@acme.io',
      },
    ],
    record: forumRecord('forum-post-7791', {
      canonicalName: 'Dmitri Ivanov',
      emails: ['dmitri.ivanov@acme.io'],
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-008' },
  },

  {
    id: 'M-FUZZY-NAME-PLUS-CONTEXT',
    description: 'Fuzzy name (Alex/Alexander) + employer + city',
    seeded: [
      {
        id: 'p-tp-009',
        canonical_name: 'Alexander Martinez',
        names_seen: ['Alexander Martinez'],
        location_city: 'San Francisco',
        location_country: 'United States',
        employer_company_id: 'comp-stripe',
      },
    ],
    record: lumaRecord('luma-evt-022:att-7', {
      canonicalName: 'Alex Martinez',
      city: 'San Francisco',
      country: 'United States',
      employerCompanyId: 'comp-stripe',
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-009' },
  },

  {
    id: 'M-NAME-EXACT-CITY-TIMEZONE',
    description: 'Name exact + same city + same timezone',
    seeded: [
      {
        id: 'p-tp-010',
        canonical_name: 'Yui Kobayashi',
        location_city: 'Tokyo',
        location_country: 'Japan',
        location_timezone: 'Asia/Tokyo',
      },
    ],
    record: twitterRecord('tw-user-555', {
      canonicalName: 'Yui Kobayashi',
      platformIdentity: { platform: 'twitter', handle: 'yui_k' },
      city: 'Tokyo',
      country: 'Japan',
      timezone: 'Asia/Tokyo',
    }),
    expected: { action: 'merge', matchedPersonId: 'p-tp-010' },
  },
];

// ---------------------------------------------------------------------------
// 10 paired records that SHOULD NOT merge (create_new or skip)
// ---------------------------------------------------------------------------

export const trueNegativeNewPersons: ResolutionFixture[] = [
  {
    id: 'N-TOTALLY-DIFFERENT',
    description: 'No shared signals — should create new Person',
    seeded: [
      {
        id: 'p-tn-001',
        canonical_name: 'John Smith',
        location_city: 'Boston',
        employer_company_id: 'comp-bank',
      },
    ],
    record: twitterRecord('tw-user-871', {
      canonicalName: 'Yuki Kobayashi',
      platformIdentity: { platform: 'twitter', handle: 'yuki_k' },
      city: 'Tokyo',
      country: 'Japan',
    }),
    expected: { action: 'create_new' },
  },

  {
    id: 'N-SHARED-FIRST-NAME-ONLY',
    description: 'Different surnames + different employers — distinct people',
    seeded: [
      {
        id: 'p-tn-002',
        canonical_name: 'John Adams',
        location_city: 'Boston',
        employer_company_id: 'comp-techco',
      },
    ],
    record: lumaRecord('luma-evt-031:att-1', {
      canonicalName: 'John Williamson',
      city: 'London',
      country: 'United Kingdom',
      employerCompanyId: 'comp-bank',
    }),
    expected: { action: 'create_new' },
  },

  {
    id: 'N-DIFFERENT-PLATFORMS-SAME-HANDLE',
    description: 'Same handle on different platforms — not an identity match',
    seeded: [
      {
        id: 'p-tn-003',
        canonical_name: 'Alice Park',
        platformIdentities: [ppi('p-tn-003', 'twitter', 'alpha')],
      },
    ],
    record: githubRecord('gh-user-2222', {
      canonicalName: 'Anna Patel',
      platformIdentity: { platform: 'github', handle: 'alpha' },
    }),
    expected: { action: 'create_new' },
  },

  {
    id: 'N-FREE-EMAIL-DIFFERENT-NAMES',
    description: 'Gmail addresses but different local parts and names — free domain ignored',
    seeded: [
      {
        id: 'p-tn-004',
        canonical_name: 'Bob Williams',
        emails_seen: ['bob@gmail.com'],
        primary_email: 'bob@gmail.com',
      },
    ],
    record: forumRecord('forum-post-2002', {
      canonicalName: 'Charlie Davis',
      emails: ['charlie@gmail.com'],
    }),
    expected: { action: 'create_new' },
  },

  {
    id: 'N-SAME-EMPLOYER-DIFFERENT-PEOPLE',
    description: 'Two distinct colleagues at the same company',
    seeded: [
      {
        id: 'p-tn-005',
        canonical_name: 'Sarah Johnson',
        location_city: 'Chicago',
        employer_company_id: 'comp-acme',
      },
    ],
    record: lumaRecord('luma-evt-040:att-12', {
      canonicalName: 'Mark Thompson',
      city: 'Chicago',
      country: 'United States',
      employerCompanyId: 'comp-acme',
    }),
    expected: { action: 'create_new' },
  },

  {
    id: 'N-FUZZY-NAME-DIFFERENT-CITY-COUNTRY',
    description:
      'Borderline-fuzzy name but cities + countries disagree — candidate lookup discards',
    seeded: [
      {
        id: 'p-tn-006',
        canonical_name: 'Bryan Smyth',
        location_city: 'Boston',
        location_country: 'United States',
      },
    ],
    record: lumaRecord('luma-evt-051:att-3', {
      canonicalName: 'Brian Smith',
      city: 'London',
      country: 'United Kingdom',
    }),
    expected: { action: 'create_new' },
  },

  {
    id: 'N-FUZZY-NAME-CONFLICTING-EMAIL',
    description: 'Fuzzy name match with no employer/city to ground it; conflicting non-free emails',
    seeded: [
      {
        id: 'p-tn-007',
        canonical_name: 'Sarah Lee',
        emails_seen: ['sarah.lee@stripe.com'],
        primary_email: 'sarah.lee@stripe.com',
      },
    ],
    record: forumRecord('forum-post-8800', {
      canonicalName: 'Sara Li',
      emails: ['sara.li@other.io'],
    }),
    // Single fuzzy name → conf ≤ 0.5 → below review threshold but candidate
    // exists → resolver should `skip`.
    expected: { action: 'skip' },
  },

  {
    id: 'N-DIFFERENT-PEOPLE-DIFFERENT-COUNTRIES',
    description: 'Same fuzzy name, different country — city signal suppressed by country mismatch',
    seeded: [
      {
        id: 'p-tn-008',
        canonical_name: 'Ayodele Ogunyemi',
        location_city: 'Lagos',
        location_country: 'Nigeria',
        location_timezone: 'Africa/Lagos',
      },
    ],
    record: lumaRecord('luma-evt-062:att-15', {
      canonicalName: 'Ayo Ogunyemi',
      city: 'São Paulo',
      country: 'Brazil',
      timezone: 'America/Sao_Paulo',
    }),
    expected: { action: 'create_new' },
  },

  {
    id: 'N-DISJOINT-IDENTITY',
    description: 'New twitter handle with no overlapping signal',
    seeded: [
      {
        id: 'p-tn-009',
        canonical_name: 'Dr. Elena Petrov',
        location_city: 'Moscow',
        location_country: 'Russia',
        employer_company_id: 'comp-statebank',
      },
    ],
    record: twitterRecord('tw-user-1001', {
      canonicalName: 'Kenji Yamada',
      platformIdentity: { platform: 'twitter', handle: 'kenji_y' },
    }),
    expected: { action: 'create_new' },
  },

  {
    id: 'N-SAME-FIRST-NAME-DIFFERENT-IDENTITY',
    description:
      'Common first name with totally different surname, different employer, different city',
    seeded: [
      {
        id: 'p-tn-010',
        canonical_name: 'Maria Sanchez',
        location_city: 'Buenos Aires',
        location_country: 'Argentina',
        employer_company_id: 'comp-mercadolibre',
      },
    ],
    record: lumaRecord('luma-evt-071:att-2', {
      canonicalName: 'Maria Bianchi',
      city: 'Milan',
      country: 'Italy',
      employerCompanyId: 'comp-fiat',
    }),
    expected: { action: 'create_new' },
  },
];

// ---------------------------------------------------------------------------
// 5 ambiguous fixtures that SHOULD land in human_review
// ---------------------------------------------------------------------------

export const ambiguousReviewCandidates: ResolutionFixture[] = [
  {
    id: 'A-FUZZY-NAME-ALONE',
    description: 'Fuzzy name match (Dmitri/Dmitry Ivanov) with no other corroboration',
    seeded: [
      {
        id: 'p-amb-001',
        canonical_name: 'Dmitri Ivanov',
        location_city: 'Berlin',
        location_country: 'Germany',
        employer_company_id: 'comp-stripe',
      },
    ],
    record: twitterRecord('tw-user-3001', {
      canonicalName: 'Dmitry Ivanov',
      platformIdentity: { platform: 'twitter', handle: 'dmitry_i' },
    }),
    expected: { action: 'human_review' },
  },

  {
    id: 'A-FUZZY-NAME-PLUS-TIMEZONE',
    description: 'Borderline-fuzzy name + identical timezone',
    seeded: [
      {
        id: 'p-amb-002',
        canonical_name: 'Sarah Lee',
        location_timezone: 'Asia/Singapore',
      },
    ],
    record: forumRecord('forum-post-3010', {
      canonicalName: 'Sara Li',
      timezone: 'Asia/Singapore',
    }),
    expected: { action: 'human_review' },
  },

  {
    id: 'A-FUZZY-NAME-PLUS-CITY',
    description: 'Lower-quality fuzzy name + same city (no country mismatch)',
    seeded: [
      {
        id: 'p-amb-003',
        canonical_name: 'Kenji Tanaka',
        location_city: 'Osaka',
      },
    ],
    record: lumaRecord('luma-evt-081:att-9', {
      canonicalName: 'Kenji Takeda',
      city: 'Osaka',
    }),
    expected: { action: 'human_review' },
  },

  {
    id: 'A-FUZZY-NAME-PLUS-MUTUAL-CONNECTION',
    description: 'High fuzzy name + two shared mutual connections',
    seeded: [
      {
        id: 'p-amb-004',
        canonical_name: 'Alice Chen',
        connectedPersonIds: ['p-other-001', 'p-other-002', 'p-other-003'],
      },
      { id: 'p-other-001', canonical_name: 'Decoy One' },
      { id: 'p-other-002', canonical_name: 'Decoy Two' },
      { id: 'p-other-003', canonical_name: 'Decoy Three' },
    ],
    record: twitterRecord('tw-user-3022', {
      canonicalName: 'Alice Cheng',
      platformIdentity: { platform: 'twitter', handle: 'alice_cheng' },
      connectedPersonIds: ['p-other-001', 'p-other-002'],
    }),
    expected: { action: 'human_review' },
  },

  {
    id: 'A-FUZZY-NAME-EVENT-CO-ATTENDANCE',
    description: 'Fuzzy name + shared event + same city — corroborated but not certain',
    seeded: [
      {
        id: 'p-amb-005',
        canonical_name: 'Maria Garcia',
        location_city: 'Madrid',
        location_country: 'Spain',
        eventIds: ['evt-cafe-madrid-01', 'evt-hack-bcn-02'],
      },
    ],
    record: lumaRecord('luma-evt-cafe-madrid-01:att-44', {
      canonicalName: 'Maria Garcia Lopez',
      city: 'Madrid',
      country: 'Spain',
      eventIds: ['evt-cafe-madrid-01'],
    }),
    expected: { action: 'human_review' },
  },
];

// ---------------------------------------------------------------------------
// All fixtures, flat — what the calibration script and resolver tests iterate.
// ---------------------------------------------------------------------------

export const ALL_FIXTURES: ResolutionFixture[] = [
  ...truePositiveMerges,
  ...trueNegativeNewPersons,
  ...ambiguousReviewCandidates,
];
