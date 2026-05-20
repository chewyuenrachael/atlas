/**
 * Normalizer unit tests for the GitHub adapter.
 *
 * The five canonical scenarios from the task brief are exercised here
 * (and again at the adapter layer in `profile-adapter.test.ts` /
 * `repo-search-adapter.test.ts`):
 *
 *   1. Profile fetch
 *   2. Repo with Cursor in README (high relevance)
 *   3. Repo with Cursor in code only (lower relevance)
 *   4. Private repo (skipped)
 *   5. User with no public activity (still emits a Person)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeCursorRelevance,
  mentionsCursor,
  normalizeGithubProfile,
  normalizeGithubRepoMatch,
} from './normalizer.js';
import type { GithubProfileResponse, GithubRepoResponse } from './client.js';
import type { RawGithubProfile, RawGithubRepoMatch } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXED_FETCHED_AT = '2026-05-20T12:00:00.000Z';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(here, '__fixtures__', name), 'utf8')) as T;
}

function fixtureText(name: string): string {
  return readFileSync(path.join(here, '__fixtures__', name), 'utf8');
}

function buildRawProfile(profileName: string, reposName: string | null): RawGithubProfile {
  const profile = fixture<GithubProfileResponse>(profileName);
  const topRepos = reposName ? fixture<GithubRepoResponse[]>(reposName) : [];
  return {
    login: profile.login,
    profile,
    topRepos,
    fetchedAt: FIXED_FETCHED_AT,
    payloadHash: 'fixed-hash-for-tests',
  };
}

describe('mentionsCursor', () => {
  it('matches case-insensitive', () => {
    expect(mentionsCursor('Cursor IDE rocks')).toBe(true);
    expect(mentionsCursor('CURSOR')).toBe(true);
    expect(mentionsCursor('cursor-rules')).toBe(true);
  });

  it('returns false for null/empty', () => {
    expect(mentionsCursor(null)).toBe(false);
    expect(mentionsCursor('')).toBe(false);
    expect(mentionsCursor(undefined)).toBe(false);
  });

  it('returns false when text lacks the word', () => {
    expect(mentionsCursor('an awesome ide')).toBe(false);
  });
});

describe('computeCursorRelevance', () => {
  it('scores README mention highest (0.9)', () => {
    const r = computeCursorRelevance({ inReadme: true, inRepoMetadata: false, inCodeOnly: false });
    expect(r.cursorRelevanceScore).toBe(0.9);
  });

  it('scores repo metadata next (0.6)', () => {
    const r = computeCursorRelevance({ inReadme: false, inRepoMetadata: true, inCodeOnly: false });
    expect(r.cursorRelevanceScore).toBe(0.6);
  });

  it('scores code-only lowest (0.3)', () => {
    const r = computeCursorRelevance({ inReadme: false, inRepoMetadata: false, inCodeOnly: true });
    expect(r.cursorRelevanceScore).toBe(0.3);
  });

  it('uses the highest available bucket when multiple signals fire', () => {
    const r = computeCursorRelevance({ inReadme: true, inRepoMetadata: true, inCodeOnly: true });
    expect(r.cursorRelevanceScore).toBe(0.9);
  });

  it('returns zero when no signals fire', () => {
    const r = computeCursorRelevance({ inReadme: false, inRepoMetadata: false, inCodeOnly: false });
    expect(r.cursorRelevanceScore).toBe(0);
  });
});

describe('normalizeGithubProfile', () => {
  it('emits a single Person record with bio + identity fields', () => {
    const raw = buildRawProfile('profile-alicechen.json', 'repos-alicechen.json');
    const records = normalizeGithubProfile(raw);
    expect(records).toHaveLength(1);
    const person = records[0];
    expect(person?.recordType).toBe('person');
    expect(person?.sourceRecordId).toBe('alicechen');
    expect(person?.sourcePlatform).toBe('github');
  });

  it('captures location, company, follower count, top repos', () => {
    const raw = buildRawProfile('profile-alicechen.json', 'repos-alicechen.json');
    const [person] = normalizeGithubProfile(raw);
    const payload = person?.payload ?? {};
    expect(payload['canonical_name']).toBe('Alice Chen');
    expect(payload['company']).toBe('JPMorgan Chase');
    expect(payload['location']).toBe('San Francisco, CA');
    expect(payload['follower_count']).toBe(1842);
    const topRepos = payload['top_repos'] as Array<{ name: string }>;
    expect(topRepos).toHaveLength(2);
    expect(topRepos.map((r) => r.name).sort()).toEqual(['cursor-rules', 'fintech-experiments']);
  });

  it('extracts twitter, linkedin, email platform_identities from the bio', () => {
    const raw = buildRawProfile('profile-alicechen.json', 'repos-alicechen.json');
    const [person] = normalizeGithubProfile(raw);
    const identities =
      (person?.payload['platform_identities'] as Array<{
        platform: string;
        handle: string;
      }>) ?? [];
    const map = new Map(identities.map((i) => [i.platform, i.handle]));
    expect(map.get('github')).toBe('alicechen');
    expect(map.get('twitter')).toBe('alicebuilds');
    expect(map.get('linkedin')).toBe('alicechenbuilds');
    expect(map.get('email')).toBe('alice.chen@example.com');
  });

  it('still emits a Person for a user with no public activity', () => {
    const raw = buildRawProfile('profile-quiet-user.json', null);
    const records = normalizeGithubProfile(raw);
    expect(records).toHaveLength(1);
    const person = records[0];
    expect(person?.sourceRecordId).toBe('quietuser');
    expect(person?.payload['public_repo_count']).toBe(0);
    expect(person?.payload['canonical_name']).toBe('quietuser');
    const topRepos = person?.payload['top_repos'] as unknown[];
    expect(topRepos).toEqual([]);
    const identities =
      (person?.payload['platform_identities'] as Array<{
        platform: string;
      }>) ?? [];
    expect(identities.map((i) => i.platform)).toEqual(['github']);
  });

  it('is byte-for-byte deterministic', () => {
    const raw = buildRawProfile('profile-alicechen.json', 'repos-alicechen.json');
    const a = JSON.stringify(normalizeGithubProfile(raw));
    const b = JSON.stringify(normalizeGithubProfile(raw));
    expect(a).toBe(b);
  });
});

describe('normalizeGithubRepoMatch', () => {
  function buildRepoMatch(
    repoFixture: string,
    readmeFixture: string | null,
    relevance: { inReadme: boolean; inRepoMetadata: boolean; inCodeOnly: boolean },
  ): RawGithubRepoMatch {
    const repo = fixture<GithubRepoResponse>(repoFixture);
    const readme = readmeFixture ? fixtureText(readmeFixture) : null;
    const scored = computeCursorRelevance(relevance);
    return {
      repoId: repo.id,
      repoNodeId: repo.node_id,
      repo,
      readme,
      relevance: scored,
      fetchedAt: FIXED_FETCHED_AT,
      payloadHash: 'fixed-hash-for-tests',
    };
  }

  it('emits Artifact + Person + Communication when Cursor is in the README', () => {
    const raw = buildRepoMatch('repo-readme-cursor.json', 'repo-readme-cursor.md', {
      inReadme: true,
      inRepoMetadata: true,
      inCodeOnly: false,
    });
    const records = normalizeGithubRepoMatch(raw);
    expect(records.map((r) => r.recordType).sort()).toEqual([
      'artifact',
      'communication',
      'person',
    ]);
    const artifact = records.find((r) => r.recordType === 'artifact');
    expect(artifact?.payload['cursor_relevance_score']).toBe(0.9);
    expect(artifact?.payload['repo_full_name']).toBe('brunot/awesome-cursor');
    expect(artifact?.payload['title']).toBe('brunot/awesome-cursor');
  });

  it('omits the Communication when README is missing or Cursor is not in README', () => {
    const raw = buildRepoMatch('repo-code-only.json', 'repo-code-only-readme.md', {
      inReadme: false,
      inRepoMetadata: false,
      inCodeOnly: true,
    });
    const records = normalizeGithubRepoMatch(raw);
    expect(records.map((r) => r.recordType).sort()).toEqual(['artifact', 'person']);
    const artifact = records.find((r) => r.recordType === 'artifact');
    expect(artifact?.payload['cursor_relevance_score']).toBe(0.3);
  });

  it('drops private repos', () => {
    const raw = buildRepoMatch('repo-private.json', null, {
      inReadme: false,
      inRepoMetadata: true,
      inCodeOnly: false,
    });
    expect(normalizeGithubRepoMatch(raw)).toEqual([]);
  });

  it('drops repos with zero relevance', () => {
    const raw = buildRepoMatch('repo-code-only.json', 'repo-code-only-readme.md', {
      inReadme: false,
      inRepoMetadata: false,
      inCodeOnly: false,
    });
    expect(normalizeGithubRepoMatch(raw)).toEqual([]);
  });

  it('classifies "mcp"-themed repos as mcp_config artifacts', () => {
    const baseRepo = fixture<GithubRepoResponse>('repo-readme-cursor.json');
    const mutated: GithubRepoResponse = {
      ...baseRepo,
      id: baseRepo.id + 100,
      description: 'MCP server for Cursor',
      topics: ['mcp', 'cursor'],
    };
    const raw: RawGithubRepoMatch = {
      repoId: mutated.id,
      repoNodeId: mutated.node_id,
      repo: mutated,
      readme: fixtureText('repo-readme-cursor.md'),
      relevance: computeCursorRelevance({
        inReadme: true,
        inRepoMetadata: true,
        inCodeOnly: false,
      }),
      fetchedAt: FIXED_FETCHED_AT,
      payloadHash: 'fixed-hash-for-tests',
    };
    const artifact = normalizeGithubRepoMatch(raw).find((r) => r.recordType === 'artifact');
    expect(artifact?.payload['artifact_type']).toBe('mcp_config');
  });

  it('is byte-for-byte deterministic', () => {
    const raw = buildRepoMatch('repo-readme-cursor.json', 'repo-readme-cursor.md', {
      inReadme: true,
      inRepoMetadata: true,
      inCodeOnly: false,
    });
    const a = JSON.stringify(normalizeGithubRepoMatch(raw));
    const b = JSON.stringify(normalizeGithubRepoMatch(raw));
    expect(a).toBe(b);
  });
});
