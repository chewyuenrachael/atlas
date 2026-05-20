/**
 * GithubProfileAdapter tests.
 *
 * Exercises the public end-to-end contract:
 *   - `fetch()` pulls profile + top repos for each ambassador
 *   - `storeRaw` is idempotent on `login`
 *   - `normalize` returns Person records via the normalizer
 *   - users with no public activity still produce a Person
 *   - a per-login fetch failure does not abort the run
 *
 * No real Octokit / network calls — a hand-rolled GithubOctokitLike stub is
 * injected through `createGithubClient`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGithubClient, type GithubClient, type GithubOctokitLike } from './client.js';
import { GithubProfileAdapter, InMemoryRawGithubProfileStore } from './profile-adapter.js';
import { StaticAmbassadorSource } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXED_CLOCK = (): Date => new Date('2026-05-20T12:00:00.000Z');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(here, '__fixtures__', name), 'utf8')) as T;
}

interface RequestCall {
  route: string;
  parameters: Record<string, unknown>;
}

function buildOctokit(opts: {
  profiles?: Record<string, unknown>;
  repos?: Record<string, unknown[]>;
  failOn?: (call: RequestCall) => Error | undefined;
}): { octokit: GithubOctokitLike; calls: RequestCall[] } {
  const calls: RequestCall[] = [];
  const headers = {
    'x-ratelimit-remaining': '4998',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-reset': '1747750000',
  };
  const octokit: GithubOctokitLike = {
    request: async (route, parameters = {}) => {
      const call: RequestCall = { route, parameters };
      calls.push(call);
      const failure = opts.failOn?.(call);
      if (failure) throw failure;
      if (route === 'GET /users/{username}') {
        const login = String(parameters['username']);
        const profile = opts.profiles?.[login];
        if (!profile) {
          const err: Error & { status?: number } = new Error('not found');
          err.status = 404;
          throw err;
        }
        return { status: 200, headers, data: profile as never };
      }
      if (route === 'GET /users/{username}/repos') {
        const login = String(parameters['username']);
        const repos = opts.repos?.[login] ?? [];
        return { status: 200, headers, data: repos as never };
      }
      throw new Error(`unexpected route in stub: ${route}`);
    },
  };
  return { octokit, calls };
}

function buildAdapter(
  logins: string[],
  octokit: GithubOctokitLike,
): { adapter: GithubProfileAdapter; store: InMemoryRawGithubProfileStore; client: GithubClient } {
  const clientResult = createGithubClient({ octokit });
  if (!clientResult.ok) throw clientResult.error;
  const client = clientResult.value;
  const store = new InMemoryRawGithubProfileStore();
  const adapter = new GithubProfileAdapter({
    ambassadors: new StaticAmbassadorSource(logins),
    client,
    store,
    now: FIXED_CLOCK,
    retryOptions: { maxAttempts: 1 },
  });
  return { adapter, store, client };
}

describe('GithubProfileAdapter', () => {
  it('fetches one raw record per ambassador login', async () => {
    const { octokit, calls } = buildOctokit({
      profiles: {
        alicechen: fixture('profile-alicechen.json'),
        quietuser: fixture('profile-quiet-user.json'),
      },
      repos: { alicechen: fixture('repos-alicechen.json'), quietuser: [] },
    });
    const { adapter } = buildAdapter(['alicechen', 'quietuser'], octokit);
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws.map((r) => r.login).sort()).toEqual(['alicechen', 'quietuser']);
    expect(calls.filter((c) => c.route.includes('/users/{username}'))).toHaveLength(4);
  });

  it('produces a stable idempotency key per login', async () => {
    const { octokit } = buildOctokit({
      profiles: { alicechen: fixture('profile-alicechen.json') },
      repos: { alicechen: fixture('repos-alicechen.json') },
    });
    const { adapter } = buildAdapter(['alicechen'], octokit);
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const keys = raws.map((r) => adapter.idempotencyKey(r));
    expect(keys).toEqual(['github:profile:alicechen']);
  });

  it('storeRaw is idempotent: re-storing the same login returns the same rawId', async () => {
    const { octokit } = buildOctokit({
      profiles: { alicechen: fixture('profile-alicechen.json') },
      repos: { alicechen: fixture('repos-alicechen.json') },
    });
    const { adapter, store } = buildAdapter(['alicechen'], octokit);
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const first = raws[0];
    if (!first) throw new Error('expected at least one raw record');
    const a = await adapter.storeRaw(first);
    const b = await adapter.storeRaw(first);
    expect(a.rawId).toBe(b.rawId);
    expect(store.size()).toBe(1);
  });

  it('normalize emits one Person record with bio + identities', async () => {
    const { octokit } = buildOctokit({
      profiles: { alicechen: fixture('profile-alicechen.json') },
      repos: { alicechen: fixture('repos-alicechen.json') },
    });
    const { adapter } = buildAdapter(['alicechen'], octokit);
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const first = raws[0];
    if (!first) throw new Error('expected at least one raw record');
    const { rawId } = await adapter.storeRaw(first);
    const records = await adapter.normalize(rawId);
    expect(records).toHaveLength(1);
    expect(records[0]?.recordType).toBe('person');
    expect(records[0]?.payload['github_login']).toBe('alicechen');
    expect(records[0]?.payload['company']).toBe('JPMorgan Chase');
  });

  it('emits a Person for a user with no public activity', async () => {
    const { octokit } = buildOctokit({
      profiles: { quietuser: fixture('profile-quiet-user.json') },
      repos: { quietuser: [] },
    });
    const { adapter } = buildAdapter(['quietuser'], octokit);
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws).toHaveLength(1);
    const first = raws[0];
    if (!first) throw new Error('expected at least one raw record');
    expect(first.topRepos).toEqual([]);
    const { rawId } = await adapter.storeRaw(first);
    const records = await adapter.normalize(rawId);
    expect(records).toHaveLength(1);
    expect(records[0]?.payload['canonical_name']).toBe('quietuser');
    expect(records[0]?.payload['public_repo_count']).toBe(0);
  });

  it('survives a per-login fetch failure and continues with the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { octokit } = buildOctokit({
      profiles: {
        alicechen: fixture('profile-alicechen.json'),
      },
      repos: {
        alicechen: fixture('repos-alicechen.json'),
      },
      failOn: (call) => {
        if (
          call.route === 'GET /users/{username}' &&
          call.parameters['username'] === 'doesnotexist'
        ) {
          const err: Error & { status?: number } = new Error('not found');
          err.status = 404;
          return err;
        }
        return undefined;
      },
    });
    const { adapter } = buildAdapter(['alicechen', 'doesnotexist'], octokit);
    const raws = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws.map((r) => r.login)).toEqual(['alicechen']);
    warn.mockRestore();
  });

  it('rejects normalize for a rawId that does not exist in the store', async () => {
    const { octokit } = buildOctokit({ profiles: {}, repos: {} });
    const { adapter } = buildAdapter([], octokit);
    await expect(adapter.normalize('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /raw github profile not found/,
    );
  });

  it('records rate-limit headers on the client', async () => {
    const { octokit } = buildOctokit({
      profiles: { alicechen: fixture('profile-alicechen.json') },
      repos: { alicechen: fixture('repos-alicechen.json') },
    });
    const { adapter, client } = buildAdapter(['alicechen'], octokit);
    for await (const _ of adapter.fetch()) {
      void _;
    }
    const rl = client.getRateLimit();
    expect(rl.remaining).toBe(4998);
    expect(rl.limit).toBe(5000);
    expect(rl.calls).toBeGreaterThan(0);
  });
});
