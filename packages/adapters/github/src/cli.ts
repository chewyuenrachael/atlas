#!/usr/bin/env node
/**
 * One-shot GitHub fetch CLI.
 *
 * Runs both adapter modes against an in-memory raw store and reports
 * counts. The CLI is the operator-facing smoke test for the package
 * — running it against live GitHub is the "Definition of done" exit
 * criterion in the task brief for SPEC.md §5.2.2.
 *
 * If `GITHUB_TOKEN` is unset the CLI exits 0 with a clear error log so it
 * can be safely invoked from a cold dev environment without crashing.
 *
 * @example
 * ```sh
 * GITHUB_TOKEN=ghp_… pnpm tsx packages/adapters/github/src/cli.ts \
 *   --logins=alicechen,brunot \
 *   --repo-query='cursor in:name,description,topics' \
 *   --limit-repos=10
 * ```
 *
 * Flags:
 *   --logins=a,b,c           Comma-separated list of ambassador logins
 *   --repo-query=<q>         Override the repo search query
 *   --code-query=<q>         Override the code search query (set to '' to skip)
 *   --limit-repos=<n>        Stop after N repo matches (smoke test)
 *   --skip-profile           Skip the profile-refresh pass
 *   --skip-repo-search       Skip the repo-search pass
 *   --json                   Emit the full NormalizedRecord[] as JSON
 */
import { logger, type NormalizedRecord } from '@atlas/core';
import { createGithubClient, isMissingTokenError } from './client.js';
import { GithubProfileAdapter } from './profile-adapter.js';
import { GithubRepoSearchAdapter } from './repo-search-adapter.js';
import { StaticAmbassadorSource } from './types.js';

interface CliArgs {
  logins: string[];
  repoQuery?: string;
  codeQuery?: string | null;
  limitRepos: number | null;
  skipProfile: boolean;
  skipRepoSearch: boolean;
  emitJson: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    logins: [],
    limitRepos: null,
    skipProfile: false,
    skipRepoSearch: false,
    emitJson: false,
  };
  for (const raw of argv) {
    if (raw === '--skip-profile') {
      args.skipProfile = true;
      continue;
    }
    if (raw === '--skip-repo-search') {
      args.skipRepoSearch = true;
      continue;
    }
    if (raw === '--json') {
      args.emitJson = true;
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    switch (key) {
      case '--logins':
        args.logins = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--repo-query':
        args.repoQuery = value;
        break;
      case '--code-query':
        args.codeQuery = value === '' ? null : value;
        break;
      case '--limit-repos': {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) args.limitRepos = Math.floor(n);
        break;
      }
      default:
        break;
    }
  }
  return args;
}

interface RunStats {
  profilesRefreshed: number;
  profileNormalized: number;
  profileFailures: number;
  reposDiscovered: number;
  repoArtifacts: number;
  repoCommunications: number;
  repoPersons: number;
  repoSkippedPrivate: number;
  repoFailures: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = logger.child({ component: 'github-cli' });

  const clientResult = createGithubClient();
  if (!clientResult.ok) {
    if (isMissingTokenError(clientResult.error)) {
      log.error(
        { env_var: 'GITHUB_TOKEN' },
        'GITHUB_TOKEN is not set; cannot run the github adapter. Set it in your .env and retry.',
      );
      process.stdout.write(
        'github cli: GITHUB_TOKEN not set; exiting cleanly without making any API calls.\n',
      );
      process.exitCode = 0;
      return;
    }
    log.error({ err: clientResult.error }, 'failed to construct github client');
    process.exitCode = 1;
    return;
  }
  const client = clientResult.value;
  log.info({ token_fingerprint: client.getTokenFingerprint() }, 'github client ready');

  const stats: RunStats = {
    profilesRefreshed: 0,
    profileNormalized: 0,
    profileFailures: 0,
    reposDiscovered: 0,
    repoArtifacts: 0,
    repoCommunications: 0,
    repoPersons: 0,
    repoSkippedPrivate: 0,
    repoFailures: 0,
  };
  const allRecords: NormalizedRecord[] = [];

  if (!args.skipProfile && args.logins.length > 0) {
    log.info({ logins: args.logins }, 'refreshing ambassador profiles');
    const adapter = new GithubProfileAdapter({
      ambassadors: new StaticAmbassadorSource(args.logins),
      client,
    });
    for await (const raw of adapter.fetch()) {
      stats.profilesRefreshed += 1;
      try {
        const { rawId } = await adapter.storeRaw(raw);
        const records = await adapter.normalize(rawId);
        stats.profileNormalized += records.length;
        for (const r of records) allRecords.push(r);
      } catch (cause) {
        stats.profileFailures += 1;
        log.warn({ err: cause, login: raw.login }, 'profile normalize failed; continuing');
      }
    }
  } else if (args.skipProfile) {
    log.info('profile-refresh pass skipped via --skip-profile');
  } else {
    log.info('no --logins provided; profile-refresh pass skipped');
  }

  if (!args.skipRepoSearch) {
    log.info(
      {
        repo_query: args.repoQuery ?? '(default)',
        code_query: args.codeQuery === null ? '(disabled)' : (args.codeQuery ?? '(default)'),
        limit_repos: args.limitRepos,
      },
      'searching for cursor-related repos',
    );
    const repoAdapter = new GithubRepoSearchAdapter({
      client,
      search: {
        ...(args.repoQuery !== undefined ? { repoQuery: args.repoQuery } : {}),
        ...(args.codeQuery !== undefined ? { codeQuery: args.codeQuery } : {}),
      },
    });
    for await (const raw of repoAdapter.fetch()) {
      stats.reposDiscovered += 1;
      try {
        const { rawId } = await repoAdapter.storeRaw(raw);
        const records = await repoAdapter.normalize(rawId);
        for (const r of records) {
          if (r.recordType === 'artifact') stats.repoArtifacts += 1;
          else if (r.recordType === 'person') stats.repoPersons += 1;
          else if (r.recordType === 'communication') stats.repoCommunications += 1;
          allRecords.push(r);
        }
      } catch (cause) {
        stats.repoFailures += 1;
        log.warn(
          { err: cause, full_name: raw.repo.full_name },
          'repo normalize failed; continuing',
        );
      }
      if (args.limitRepos !== null && stats.reposDiscovered >= args.limitRepos) {
        log.info({ limit: args.limitRepos }, 'repo limit reached');
        break;
      }
    }
  } else {
    log.info('repo-search pass skipped via --skip-repo-search');
  }

  const rateLimit = client.getRateLimit();
  log.info(
    {
      profiles_refreshed: stats.profilesRefreshed,
      profile_normalized_records: stats.profileNormalized,
      profile_failures: stats.profileFailures,
      repos_discovered: stats.reposDiscovered,
      repo_artifacts: stats.repoArtifacts,
      repo_persons: stats.repoPersons,
      repo_communications: stats.repoCommunications,
      repo_failures: stats.repoFailures,
      api_calls: rateLimit.calls,
      rate_limit_remaining: rateLimit.remaining,
      rate_limit_limit: rateLimit.limit,
      rate_limit_reset_epoch: rateLimit.resetEpoch,
    },
    'github cli complete',
  );

  process.stdout.write(
    [
      'github one-shot fetch — summary',
      `  profiles refreshed:     ${stats.profilesRefreshed}`,
      `  profile records:        ${stats.profileNormalized}`,
      `  profile failures:       ${stats.profileFailures}`,
      `  repos discovered:       ${stats.reposDiscovered}`,
      `    artifacts:            ${stats.repoArtifacts}`,
      `    persons (owners):     ${stats.repoPersons}`,
      `    communications:       ${stats.repoCommunications}`,
      `  repo failures:          ${stats.repoFailures}`,
      `  api calls:              ${rateLimit.calls}`,
      `  rate limit remaining:   ${rateLimit.remaining ?? '(unknown)'} / ${rateLimit.limit ?? '?'}`,
      rateLimit.resetEpoch
        ? `  rate limit resets at:   ${new Date(rateLimit.resetEpoch * 1000).toISOString()}`
        : '',
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (args.emitJson) {
    process.stdout.write(JSON.stringify(allRecords, null, 2) + '\n');
  }
}

main().catch((cause: unknown) => {
  logger.error({ err: cause }, 'github cli failed');
  process.exitCode = 1;
});
