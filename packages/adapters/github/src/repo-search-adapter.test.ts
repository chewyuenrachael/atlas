/**
 * GithubRepoSearchAdapter tests.
 *
 * Covers:
 *   - repo discovered with Cursor in README + metadata (high relevance, 0.9)
 *   - repo discovered only via code search (low relevance, 0.3)
 *   - private repos returned by search are filtered out
 *   - repos with zero relevance signal are dropped before persistence
 *   - missing README is tolerated (warning, not crash)
 *   - rate-limit headers are observed on the client
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createGithubClient,
  type GithubClient,
  type GithubOctokitLike,
  type GithubRepoResponse,
} from './client.js';
import {
  GithubRepoSearchAdapter,
  InMemoryRawGithubRepoStore,
  scoreRelevance,
} from './repo-search-adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXED_CLOCK = (): Date => new Date('2026-05-20T12:00:00.000Z');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(here, '__fixtures__', name), 'utf8')) as T;
}

function fixtureText(name: string): string {
  return readFileSync(path.join(here, '__fixtures__', name), 'utf8');
}

interface OctokitScenario {
  /** Returned by `GET /search/repositories`. */
  searchRepos?: GithubRepoResponse[];
  /** Returned by `GET /search/code`. Items reference `repository.full_name`. */
  searchCode?: Array<{ full_name: string }>;
  /** READMEs keyed by `${owner}/${repo}`. Missing entries return 404. */
  readmes?: Record<string, string>;
  /** Repo metadata keyed by `${owner}/${repo}` for code-only hydration. */
  reposByFullName?: Record<string, GithubRepoResponse>;
  /** Optional override of rate-limit headers. */
  headers?: Record<string, string>;
}

function buildOctokit(scenario: OctokitScenario): {
  octokit: GithubOctokitLike;
  calls: Array<{ route: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const headers = scenario.headers ?? {
    'x-ratelimit-remaining': '4997',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-reset': '1747750000',
  };
  const octokit: GithubOctokitLike = {
    request: async (route, params = {}) => {
      calls.push({ route, params });
      if (route === 'GET /search/repositories') {
        return {
          status: 200,
          headers,
          data: {
            total_count: (scenario.searchRepos ?? []).length,
            items: scenario.searchRepos ?? [],
          } as never,
        };
      }
      if (route === 'GET /search/code') {
        const items = (scenario.searchCode ?? []).map((c) => ({ repository: c }));
        return {
          status: 200,
          headers,
          data: { total_count: items.length, items } as never,
        };
      }
      if (route === 'GET /repos/{owner}/{repo}') {
        const key = `${params['owner']}/${params['repo']}`;
        const repo = scenario.reposByFullName?.[key];
        if (!repo) {
          const err: Error & { status?: number } = new Error(`repo not found: ${key}`);
          err.status = 404;
          throw err;
        }
        return { status: 200, headers, data: repo as never };
      }
      if (route === 'GET /repos/{owner}/{repo}/readme') {
        const key = `${params['owner']}/${params['repo']}`;
        const text = scenario.readmes?.[key];
        if (text === undefined) {
          const err: Error & { status?: number } = new Error(`readme not found: ${key}`);
          err.status = 404;
          throw err;
        }
        return {
          status: 200,
          headers,
          data: {
            content: Buffer.from(text, 'utf8').toString('base64'),
            encoding: 'base64',
            size: text.length,
            name: 'README.md',
          } as never,
        };
      }
      throw new Error(`unexpected route in stub: ${route}`);
    },
  };
  return { octokit, calls };
}

function buildAdapter(
  octokit: GithubOctokitLike,
  overrides: { codeQuery?: string | null } = {},
): { adapter: GithubRepoSearchAdapter; store: InMemoryRawGithubRepoStore; client: GithubClient } {
  const clientResult = createGithubClient({ octokit });
  if (!clientResult.ok) throw clientResult.error;
  const client = clientResult.value;
  const store = new InMemoryRawGithubRepoStore();
  const search: { codeQuery?: string | null } = {};
  if (overrides.codeQuery !== undefined) {
    search.codeQuery = overrides.codeQuery;
  }
  const adapter = new GithubRepoSearchAdapter({
    client,
    store,
    search,
    now: FIXED_CLOCK,
    retryOptions: { maxAttempts: 1 },
  });
  return { adapter, store, client };
}

describe('scoreRelevance', () => {
  it('flags repo metadata + README as high relevance', () => {
    const repo = fixture<GithubRepoResponse>('repo-readme-cursor.json');
    const readme = fixtureText('repo-readme-cursor.md');
    const r = scoreRelevance({ repo, readme });
    expect(r.inReadme).toBe(true);
    expect(r.inRepoMetadata).toBe(true);
    expect(r.cursorRelevanceScore).toBe(0.9);
  });

  it('flags repo with code-only hint as low relevance when README and metadata are silent', () => {
    const repo = fixture<GithubRepoResponse>('repo-code-only.json');
    const readme = fixtureText('repo-code-only-readme.md');
    const r = scoreRelevance({ repo, readme, codeOnlyHint: true });
    expect(r.inReadme).toBe(false);
    expect(r.inRepoMetadata).toBe(false);
    expect(r.inCodeOnly).toBe(true);
    expect(r.cursorRelevanceScore).toBe(0.3);
  });

  it('returns zero score when nothing matches', () => {
    const repo = fixture<GithubRepoResponse>('repo-code-only.json');
    const readme = fixtureText('repo-code-only-readme.md');
    const r = scoreRelevance({ repo, readme });
    expect(r.cursorRelevanceScore).toBe(0);
  });
});

describe('GithubRepoSearchAdapter', () => {
  it('discovers a repo with Cursor in README (high relevance, full normalized triple)', async () => {
    const repo = fixture<GithubRepoResponse>('repo-readme-cursor.json');
    const { octokit } = buildOctokit({
      searchRepos: [repo],
      readmes: { 'brunot/awesome-cursor': fixtureText('repo-readme-cursor.md') },
    });
    const { adapter } = buildAdapter(octokit, { codeQuery: null });
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws).toHaveLength(1);
    const first = raws[0];
    if (!first) throw new Error('expected one raw record');
    expect(first.relevance.cursorRelevanceScore).toBe(0.9);
    expect(first.relevance.inReadme).toBe(true);

    const { rawId } = await adapter.storeRaw(first);
    const records = await adapter.normalize(rawId);
    expect(records.map((r) => r.recordType).sort()).toEqual([
      'artifact',
      'communication',
      'person',
    ]);
  });

  it('discovers a code-only repo via search/code and assigns lower relevance', async () => {
    const repo = fixture<GithubRepoResponse>('repo-code-only.json');
    const { octokit } = buildOctokit({
      searchRepos: [],
      searchCode: [{ full_name: 'carol/fintech-tools' }],
      reposByFullName: { 'carol/fintech-tools': repo },
      readmes: { 'carol/fintech-tools': fixtureText('repo-code-only-readme.md') },
    });
    const { adapter } = buildAdapter(octokit);
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws).toHaveLength(1);
    expect(raws[0]?.relevance.cursorRelevanceScore).toBe(0.3);
    expect(raws[0]?.relevance.inCodeOnly).toBe(true);

    const first = raws[0];
    if (!first) throw new Error('expected one raw record');
    const { rawId } = await adapter.storeRaw(first);
    const records = await adapter.normalize(rawId);
    expect(records.map((r) => r.recordType).sort()).toEqual(['artifact', 'person']);
    expect(records.some((r) => r.recordType === 'communication')).toBe(false);
  });

  it('skips private repos returned by search', async () => {
    const privateRepo = fixture<GithubRepoResponse>('repo-private.json');
    const publicRepo = fixture<GithubRepoResponse>('repo-readme-cursor.json');
    const { octokit } = buildOctokit({
      searchRepos: [privateRepo, publicRepo],
      readmes: { 'brunot/awesome-cursor': fixtureText('repo-readme-cursor.md') },
    });
    const { adapter } = buildAdapter(octokit, { codeQuery: null });
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws.map((r) => r.repo.full_name)).toEqual(['brunot/awesome-cursor']);
  });

  it('tolerates missing README without crashing', async () => {
    const repo = fixture<GithubRepoResponse>('repo-readme-cursor.json');
    const { octokit } = buildOctokit({
      searchRepos: [repo],
      readmes: {}, // no readme registered → stub returns 404
    });
    const { adapter } = buildAdapter(octokit, { codeQuery: null });
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws).toHaveLength(1);
    const first = raws[0];
    if (!first) throw new Error('expected one raw record');
    expect(first.readme).toBeNull();
    // Still has metadata match → relevance 0.6
    expect(first.relevance.cursorRelevanceScore).toBe(0.6);
    const { rawId } = await adapter.storeRaw(first);
    const records = await adapter.normalize(rawId);
    expect(records.find((r) => r.recordType === 'communication')).toBeUndefined();
  });

  it('storeRaw is idempotent on repo id', async () => {
    const repo = fixture<GithubRepoResponse>('repo-readme-cursor.json');
    const { octokit } = buildOctokit({
      searchRepos: [repo],
      readmes: { 'brunot/awesome-cursor': fixtureText('repo-readme-cursor.md') },
    });
    const { adapter, store } = buildAdapter(octokit, { codeQuery: null });
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const first = raws[0];
    if (!first) throw new Error('expected one raw record');
    const a = await adapter.storeRaw(first);
    const b = await adapter.storeRaw(first);
    expect(a.rawId).toBe(b.rawId);
    expect(store.size()).toBe(1);
  });

  it('continues when search/code fails (e.g. PAT missing scope)', async () => {
    const repo = fixture<GithubRepoResponse>('repo-readme-cursor.json');
    const octokit: GithubOctokitLike = {
      request: async (route, params = {}) => {
        if (route === 'GET /search/repositories') {
          return {
            status: 200,
            headers: { 'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000' },
            data: { total_count: 1, items: [repo] } as never,
          };
        }
        if (route === 'GET /search/code') {
          const err: Error & { status?: number } = new Error('forbidden');
          err.status = 403;
          throw err;
        }
        if (route === 'GET /repos/{owner}/{repo}/readme') {
          const text = fixtureText('repo-readme-cursor.md');
          return {
            status: 200,
            headers: {},
            data: {
              content: Buffer.from(text, 'utf8').toString('base64'),
              encoding: 'base64',
              size: text.length,
              name: 'README.md',
            } as never,
          };
        }
        throw new Error(`unexpected route in stub: ${route} ${JSON.stringify(params)}`);
      },
    };
    const { adapter } = buildAdapter(octokit);
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws).toHaveLength(1);
  });

  it('observes rate-limit headers', async () => {
    const repo = fixture<GithubRepoResponse>('repo-readme-cursor.json');
    const { octokit } = buildOctokit({
      searchRepos: [repo],
      readmes: { 'brunot/awesome-cursor': fixtureText('repo-readme-cursor.md') },
      headers: {
        'x-ratelimit-remaining': '4500',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1747800000',
      },
    });
    const { adapter, client } = buildAdapter(octokit, { codeQuery: null });
    for await (const _ of adapter.fetch()) {
      void _;
    }
    const rl = client.getRateLimit();
    expect(rl.remaining).toBe(4500);
    expect(rl.limit).toBe(5000);
    expect(rl.resetEpoch).toBe(1747800000);
  });
});
