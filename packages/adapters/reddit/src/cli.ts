#!/usr/bin/env node
/**
 * One-shot Reddit fetch CLI.
 *
 * Polls every configured subreddit, fetches top comments for posts that
 * pass the cursor-relevance filter, runs the full normalization pipeline
 * against an in-memory raw store, and reports counts plus a cursor-
 * relevance histogram. This is the operator-facing smoke test for the
 * adapter — running it against the live Reddit API is the "Definition of
 * done" exit criterion in the task brief for SPEC.md §5.2.5.
 *
 * @example
 * ```sh
 * pnpm --filter @atlas/adapter-reddit cli
 * # → posts: 24, comments: 117, normalized: 156
 * ```
 *
 * Flags:
 *   --subreddits=<csv>    Comma-separated subreddits (default: SPEC list)
 *   --posts-per=<n>       Posts per subreddit (default 25)
 *   --comments-per=<n>    Comments per post (default 50)
 *   --min-relevance=<f>   Drop items below this score (default 0)
 *   --json                Emit normalized records as JSON
 *   --limit=<n>           Stop after N raw items (smoke test)
 */
import { logger, type NormalizedRecord } from '@atlas/core';
import { RedditAdapter, DEFAULT_SUBREDDITS } from './adapter.js';
import type { RawRedditItem } from './types.js';

interface CliArgs {
  subreddits: readonly string[];
  postsPerSubreddit: number;
  commentsPerPost: number;
  minRelevance: number;
  emitJson: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    subreddits: DEFAULT_SUBREDDITS,
    postsPerSubreddit: 25,
    commentsPerPost: 50,
    minRelevance: 0,
    emitJson: false,
    limit: null,
  };
  for (const raw of argv) {
    if (raw === '--json') {
      args.emitJson = true;
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    switch (key) {
      case '--subreddits':
        args.subreddits = value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      case '--posts-per': {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) args.postsPerSubreddit = Math.floor(n);
        break;
      }
      case '--comments-per': {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) args.commentsPerPost = Math.floor(n);
        break;
      }
      case '--min-relevance': {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0 && n <= 1) args.minRelevance = n;
        break;
      }
      case '--limit': {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
        break;
      }
      default:
        break;
    }
  }
  return args;
}

interface RunStats {
  postsFetched: number;
  commentsFetched: number;
  deletedAuthors: number;
  removedBodies: number;
  normalizedRecords: number;
  communicationRecords: number;
  personRecords: number;
  failedDuringStore: number;
  failedDuringNormalize: number;
  /** Histogram buckets in [0, 0.25), [0.25, 0.5), [0.5, 0.75), [0.75, 1]. */
  relevanceHistogram: [number, number, number, number];
  perSubreddit: Map<string, number>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = logger.child({ component: 'reddit-cli' });

  log.info(
    {
      subreddits: args.subreddits,
      posts_per: args.postsPerSubreddit,
      comments_per: args.commentsPerPost,
      min_relevance: args.minRelevance,
      limit: args.limit,
    },
    'starting reddit one-shot fetch',
  );

  const adapter = new RedditAdapter({
    subreddits: args.subreddits,
    postsPerSubreddit: args.postsPerSubreddit,
    topCommentsPerPost: args.commentsPerPost,
    minCursorRelevance: args.minRelevance,
  });

  const stats: RunStats = {
    postsFetched: 0,
    commentsFetched: 0,
    deletedAuthors: 0,
    removedBodies: 0,
    normalizedRecords: 0,
    communicationRecords: 0,
    personRecords: 0,
    failedDuringStore: 0,
    failedDuringNormalize: 0,
    relevanceHistogram: [0, 0, 0, 0],
    perSubreddit: new Map(),
  };
  const allRecords: NormalizedRecord[] = [];

  let processed = 0;
  for await (const raw of adapter.fetch()) {
    processed += 1;
    if (raw.kind === 't3') stats.postsFetched += 1;
    else stats.commentsFetched += 1;
    bucketize(stats.relevanceHistogram, raw.cursorRelevance.score);
    stats.perSubreddit.set(
      raw.subreddit,
      (stats.perSubreddit.get(raw.subreddit) ?? 0) + 1,
    );
    if (isDeletedAuthor(raw)) stats.deletedAuthors += 1;
    if (isRemovedBody(raw)) stats.removedBodies += 1;

    let rawId: string;
    try {
      ({ rawId } = await adapter.storeRaw(raw));
    } catch (cause) {
      stats.failedDuringStore += 1;
      log.warn({ err: cause, thing_id: raw.thingId }, 'store failed; skipping');
      continue;
    }
    let records: NormalizedRecord[];
    try {
      records = await adapter.normalize(rawId);
    } catch (cause) {
      stats.failedDuringNormalize += 1;
      log.warn({ err: cause, raw_id: rawId }, 'normalize failed; skipping');
      continue;
    }
    stats.normalizedRecords += records.length;
    for (const r of records) {
      if (r.recordType === 'communication') stats.communicationRecords += 1;
      if (r.recordType === 'person') stats.personRecords += 1;
      allRecords.push(r);
    }
    if (args.limit !== null && processed >= args.limit) break;
  }

  log.info(
    {
      posts_fetched: stats.postsFetched,
      comments_fetched: stats.commentsFetched,
      deleted_authors: stats.deletedAuthors,
      removed_bodies: stats.removedBodies,
      normalized_records: stats.normalizedRecords,
      communication_records: stats.communicationRecords,
      person_records: stats.personRecords,
      failed_during_store: stats.failedDuringStore,
      failed_during_normalize: stats.failedDuringNormalize,
      relevance_histogram: stats.relevanceHistogram,
    },
    'reddit fetch complete',
  );

  const perSubredditLines: string[] = [];
  for (const [sub, count] of [...stats.perSubreddit.entries()].sort((a, b) => b[1] - a[1])) {
    perSubredditLines.push(`    r/${sub.padEnd(20)} ${count}`);
  }

  process.stdout.write(
    [
      'reddit one-shot fetch — summary',
      `  posts fetched:           ${stats.postsFetched}`,
      `  comments fetched:        ${stats.commentsFetched}`,
      `  deleted authors:         ${stats.deletedAuthors}`,
      `  removed bodies:          ${stats.removedBodies}`,
      `  normalized records:      ${stats.normalizedRecords}`,
      `    communications:        ${stats.communicationRecords}`,
      `    persons:               ${stats.personRecords}`,
      `  store failures:          ${stats.failedDuringStore}`,
      `  normalize failures:      ${stats.failedDuringNormalize}`,
      '  cursor-relevance distribution:',
      `    [0.00–0.25):           ${stats.relevanceHistogram[0]}`,
      `    [0.25–0.50):           ${stats.relevanceHistogram[1]}`,
      `    [0.50–0.75):           ${stats.relevanceHistogram[2]}`,
      `    [0.75–1.00]:           ${stats.relevanceHistogram[3]}`,
      '  per-subreddit raw items:',
      ...perSubredditLines,
      '',
    ].join('\n'),
  );

  if (args.emitJson) {
    process.stdout.write(JSON.stringify(allRecords, null, 2) + '\n');
  }
}

function bucketize(buckets: [number, number, number, number], score: number): void {
  if (score < 0.25) buckets[0] += 1;
  else if (score < 0.5) buckets[1] += 1;
  else if (score < 0.75) buckets[2] += 1;
  else buckets[3] += 1;
}

function isDeletedAuthor(raw: RawRedditItem): boolean {
  return raw.envelope.data.author === '[deleted]';
}

function isRemovedBody(raw: RawRedditItem): boolean {
  if (raw.envelope.kind === 't3') {
    const text = raw.envelope.data.selftext ?? '';
    return text === '[removed]' || text === '[deleted]';
  }
  const body = raw.envelope.data.body;
  return body === '[removed]' || body === '[deleted]';
}

main().catch((cause: unknown) => {
  logger.error({ err: cause }, 'reddit cli failed');
  process.exitCode = 1;
});
