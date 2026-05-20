/**
 * `github-profile-refresh` — weekly ambassador profile refresh.
 *
 * SPEC.md §5.2.2: "Schedule: Weekly per known ambassador." This workflow
 * is the production wrapper around {@link GithubProfileAdapter} that runs
 * on the Inngest cron schedule. Each step is a `step.run` so Inngest's
 * durable execution handles partial failure.
 *
 * Phase 2 wiring boundary: the production ambassador source ultimately
 * reads `person_platform_identity` rows where `platform = 'github'`. The
 * task brief constrains this PR to in-memory stores, so we ship an
 * injectable {@link GithubProfileRefreshDeps.ambassadorSource} that
 * defaults to {@link DefaultAmbassadorSource} — a placeholder that resolves
 * to an empty list and logs a clear notice. A follow-up PR replaces the
 * default with the Supabase-backed query.
 *
 * If `GITHUB_TOKEN` is not set the workflow exits cleanly without making
 * any external requests, mirroring the CLI behavior.
 */
import {
  createGithubClient,
  GithubProfileAdapter,
  isMissingTokenError,
  StaticAmbassadorSource,
  type AmbassadorSource,
  type GithubClient,
  type RawGithubProfileStore,
} from '@atlas/adapter-github';
import { logger, type Logger, type NormalizedRecord } from '@atlas/core';
import { inngest } from './inngest-client.js';

// ---------------------------------------------------------------------------
// Result + deps
// ---------------------------------------------------------------------------

export interface GithubProfileRefreshStats {
  profiles_attempted: number;
  raw_inserted: number;
  raw_existed: number;
  raw_persist_failures: number;
  normalized_records: number;
  normalize_failures: number;
  skipped_due_to_missing_token: boolean;
  api_calls: number;
  rate_limit_remaining: number | null;
}

function emptyStats(): GithubProfileRefreshStats {
  return {
    profiles_attempted: 0,
    raw_inserted: 0,
    raw_existed: 0,
    raw_persist_failures: 0,
    normalized_records: 0,
    normalize_failures: 0,
    skipped_due_to_missing_token: false,
    api_calls: 0,
    rate_limit_remaining: null,
  };
}

export interface GithubProfileRefreshDeps {
  /** Ambassador source. Defaults to an empty list — workflow becomes a no-op. */
  ambassadorSource?: AmbassadorSource;
  /** Pre-built client (tests). Production builds via `createGithubClient()`. */
  client?: GithubClient;
  /** Raw store override. Defaults to {@link InMemoryRawGithubProfileStore}. */
  rawStore?: RawGithubProfileStore;
  /** Logger override. */
  logger?: Logger;
}

/**
 * Default ambassador source: empty list. The workflow logs a warning when
 * it observes this default so operators know to wire in the real source.
 *
 * Production deployment swaps this for a Supabase-backed implementation
 * (out of scope for this PR per the task brief).
 */
class DefaultAmbassadorSource implements AmbassadorSource {
  async list(): Promise<string[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure entry point (also re-used by the Inngest function below)
// ---------------------------------------------------------------------------

/**
 * Run the profile refresh end-to-end. Returns counts even if the API token
 * is missing — operators want the {@link GithubProfileRefreshStats.skipped_due_to_missing_token}
 * flag to surface in dashboards rather than a thrown error.
 *
 * @example
 * ```ts
 * const stats = await runGithubProfileRefresh({
 *   ambassadorSource: new StaticAmbassadorSource(['alicechen', 'brunot']),
 * });
 * console.log(`refreshed ${stats.profiles_attempted}`);
 * ```
 */
export async function runGithubProfileRefresh(
  deps: GithubProfileRefreshDeps = {},
): Promise<GithubProfileRefreshStats> {
  const log = deps.logger ?? logger.child({ workflow: 'github-profile-refresh' });
  const stats = emptyStats();
  const ambassadorSource = deps.ambassadorSource ?? new DefaultAmbassadorSource();

  let client = deps.client;
  if (!client) {
    const result = createGithubClient();
    if (!result.ok) {
      if (isMissingTokenError(result.error)) {
        stats.skipped_due_to_missing_token = true;
        log.error(
          { env_var: 'GITHUB_TOKEN' },
          'GITHUB_TOKEN not set; skipping github-profile-refresh run',
        );
        return stats;
      }
      throw result.error;
    }
    client = result.value;
  }

  const logins = await ambassadorSource.list();
  if (logins.length === 0) {
    log.warn(
      'no ambassador GitHub logins were resolved; ' +
        'wire up an AmbassadorSource backed by person_platform_identity in a follow-up PR',
    );
    return stats;
  }

  const adapter = new GithubProfileAdapter({
    ambassadors: new StaticAmbassadorSource(logins),
    client,
    ...(deps.rawStore !== undefined ? { store: deps.rawStore } : {}),
  });

  const persisted: Array<{ rawId: string; login: string }> = [];
  for await (const raw of adapter.fetch()) {
    stats.profiles_attempted += 1;
    try {
      const { rawId } = await adapter.storeRaw(raw);
      stats.raw_inserted += 1; // store doesn't expose `existed` through adapter.storeRaw; treat as inserted
      persisted.push({ rawId, login: raw.login });
    } catch (cause) {
      stats.raw_persist_failures += 1;
      log.warn({ err: cause, login: raw.login }, 'failed to persist raw github profile');
    }
  }

  const records: NormalizedRecord[] = [];
  for (const item of persisted) {
    try {
      const out = await adapter.normalize(item.rawId);
      stats.normalized_records += out.length;
      for (const r of out) records.push(r);
    } catch (cause) {
      stats.normalize_failures += 1;
      log.warn({ err: cause, login: item.login }, 'github profile normalize failed');
    }
  }

  const rateLimit = client.getRateLimit();
  stats.api_calls = rateLimit.calls;
  stats.rate_limit_remaining = rateLimit.remaining;

  log.info(
    {
      profiles_attempted: stats.profiles_attempted,
      normalized_records: stats.normalized_records,
      raw_persist_failures: stats.raw_persist_failures,
      normalize_failures: stats.normalize_failures,
      api_calls: stats.api_calls,
      rate_limit_remaining: stats.rate_limit_remaining,
    },
    'github-profile-refresh complete',
  );
  return stats;
}

// ---------------------------------------------------------------------------
// Inngest function
// ---------------------------------------------------------------------------

/**
 * Inngest function — wraps {@link runGithubProfileRefresh} so retries are
 * durable and re-runs are safe.
 *
 * Cron: weekly (Mondays at 09:00 UTC — outside of high-traffic API hours).
 */
export const githubProfileRefresh = inngest.createFunction(
  { id: 'github-profile-refresh', name: 'GitHub — weekly ambassador profile refresh' },
  { cron: '0 9 * * 1' },
  async ({ step }) => {
    return step.run('run', async () => {
      return runGithubProfileRefresh();
    });
  },
);
