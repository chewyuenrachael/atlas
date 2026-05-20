/**
 * `github-repo-search` — daily search for Cursor-related repositories.
 *
 * SPEC.md §5.2.2: "Real-time for high-value mentions" is a Phase 3+ concern.
 * Phase 2 ships a daily search that picks up new Cursor-related repos and
 * READMEs and routes them through {@link GithubRepoSearchAdapter}.
 *
 * If `GITHUB_TOKEN` is unset the workflow exits cleanly without making any
 * API calls, mirroring the CLI and profile-refresh workflow.
 */
import {
  createGithubClient,
  GithubRepoSearchAdapter,
  isMissingTokenError,
  type GithubClient,
  type RawGithubRepoStore,
  type RepoSearchOptions,
} from '@atlas/adapter-github';
import { logger, type Logger, type NormalizedRecord } from '@atlas/core';
import { inngest } from './inngest-client.js';

// ---------------------------------------------------------------------------
// Result + deps
// ---------------------------------------------------------------------------

export interface GithubRepoSearchStats {
  repos_discovered: number;
  raw_persist_failures: number;
  normalized_records: number;
  normalize_failures: number;
  artifacts: number;
  persons: number;
  communications: number;
  skipped_due_to_missing_token: boolean;
  api_calls: number;
  rate_limit_remaining: number | null;
}

function emptyStats(): GithubRepoSearchStats {
  return {
    repos_discovered: 0,
    raw_persist_failures: 0,
    normalized_records: 0,
    normalize_failures: 0,
    artifacts: 0,
    persons: 0,
    communications: 0,
    skipped_due_to_missing_token: false,
    api_calls: 0,
    rate_limit_remaining: null,
  };
}

export interface GithubRepoSearchDeps {
  /** Pre-built client (tests). Production builds via `createGithubClient()`. */
  client?: GithubClient;
  /** Raw store override. Defaults to {@link InMemoryRawGithubRepoStore}. */
  rawStore?: RawGithubRepoStore;
  /** Search options override. */
  search?: RepoSearchOptions;
  /** Logger override. */
  logger?: Logger;
  /** Stop after `limit` raw repos. Useful for smoke tests. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Pure entry point
// ---------------------------------------------------------------------------

/**
 * Run the Cursor-repo search end-to-end.
 *
 * @example
 * ```ts
 * const stats = await runGithubRepoSearch({ limit: 5 });
 * console.log(`discovered ${stats.repos_discovered} repos, ${stats.artifacts} artifacts`);
 * ```
 */
export async function runGithubRepoSearch(
  deps: GithubRepoSearchDeps = {},
): Promise<GithubRepoSearchStats> {
  const log = deps.logger ?? logger.child({ workflow: 'github-repo-search' });
  const stats = emptyStats();

  let client = deps.client;
  if (!client) {
    const result = createGithubClient();
    if (!result.ok) {
      if (isMissingTokenError(result.error)) {
        stats.skipped_due_to_missing_token = true;
        log.error(
          { env_var: 'GITHUB_TOKEN' },
          'GITHUB_TOKEN not set; skipping github-repo-search run',
        );
        return stats;
      }
      throw result.error;
    }
    client = result.value;
  }

  const adapter = new GithubRepoSearchAdapter({
    client,
    ...(deps.rawStore !== undefined ? { store: deps.rawStore } : {}),
    ...(deps.search !== undefined ? { search: deps.search } : {}),
  });

  const persisted: string[] = [];
  for await (const raw of adapter.fetch()) {
    stats.repos_discovered += 1;
    try {
      const { rawId } = await adapter.storeRaw(raw);
      persisted.push(rawId);
    } catch (cause) {
      stats.raw_persist_failures += 1;
      log.warn({ err: cause, full_name: raw.repo.full_name }, 'failed to persist raw github repo');
    }
    if (deps.limit !== undefined && persisted.length >= deps.limit) {
      log.info({ limit: deps.limit }, 'limit reached; stopping repo-search');
      break;
    }
  }

  for (const rawId of persisted) {
    try {
      const records = await adapter.normalize(rawId);
      stats.normalized_records += records.length;
      bumpRecordTypeCounts(stats, records);
    } catch (cause) {
      stats.normalize_failures += 1;
      log.warn({ err: cause, raw_id: rawId }, 'github repo normalize failed');
    }
  }

  const rateLimit = client.getRateLimit();
  stats.api_calls = rateLimit.calls;
  stats.rate_limit_remaining = rateLimit.remaining;

  log.info(
    {
      repos_discovered: stats.repos_discovered,
      artifacts: stats.artifacts,
      persons: stats.persons,
      communications: stats.communications,
      raw_persist_failures: stats.raw_persist_failures,
      normalize_failures: stats.normalize_failures,
      api_calls: stats.api_calls,
      rate_limit_remaining: stats.rate_limit_remaining,
    },
    'github-repo-search complete',
  );
  return stats;
}

function bumpRecordTypeCounts(stats: GithubRepoSearchStats, records: NormalizedRecord[]): void {
  for (const r of records) {
    switch (r.recordType) {
      case 'artifact':
        stats.artifacts += 1;
        break;
      case 'person':
        stats.persons += 1;
        break;
      case 'communication':
        stats.communications += 1;
        break;
      case 'event':
      case 'company':
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Inngest function
// ---------------------------------------------------------------------------

/**
 * Inngest function — wraps {@link runGithubRepoSearch}.
 *
 * Cron: daily at 04:00 UTC (off-peak for GitHub API).
 */
export const githubRepoSearch = inngest.createFunction(
  { id: 'github-repo-search', name: 'GitHub — daily Cursor repo search' },
  { cron: '0 4 * * *' },
  async ({ step }) => {
    return step.run('run', async () => {
      return runGithubRepoSearch();
    });
  },
);
