/**
 * GithubRepoSearchAdapter — discovers Cursor-related repositories.
 *
 * SPEC.md §5.2.2: "Public mentions of 'cursor' in repos, issues, READMEs."
 * The adapter performs two passes per scheduled run:
 *
 *   1. `search/repositories` for repos whose name/description/topics mention
 *      Cursor.
 *   2. (Optional) `search/code` for repos that mention Cursor only in source
 *      code — lower relevance bucket.
 *
 * For each repo it pulls the README, computes a {@link CursorRelevance}
 * score, and emits a {@link RawGithubRepoMatch}.
 *
 * Private repos are filtered out at both the search-results layer (search
 * endpoints don't return them for a PAT without `repo` scope) and at this
 * adapter as a defensive check.
 *
 * @example
 * ```ts
 * const adapter = new GithubRepoSearchAdapter({ client });
 * for await (const raw of adapter.fetch()) {
 *   const { rawId } = await adapter.storeRaw(raw);
 *   const records = await adapter.normalize(rawId);
 * }
 * ```
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  IngestionError,
  NormalizationError,
  RATE_LIMIT_GITHUB,
  logger,
  type Cursor,
  type Logger,
  type NormalizedRecord,
  type RateLimitConfig,
  type UUID,
} from '@atlas/core';
import { BaseSourceAdapter, type RetryOptions } from '@atlas/adapters-shared';
import type { GithubClient, GithubRepoResponse } from './client.js';
import { computeCursorRelevance, mentionsCursor, normalizeGithubRepoMatch } from './normalizer.js';
import type { CursorRelevance, RawGithubRepoMatch, RepoSearchOptions } from './types.js';

const DEFAULT_REPO_QUERY = 'cursor in:name,description,topics';
const DEFAULT_CODE_QUERY = '"@cursor/sdk" OR "cursor.composer"';

// ---------------------------------------------------------------------------
// Storage abstraction
// ---------------------------------------------------------------------------

export interface RawGithubRepoStore {
  insert(record: RawGithubRepoMatch): Promise<{ rawId: UUID; existed: boolean }>;
  getById(rawId: UUID): Promise<RawGithubRepoMatch | null>;
  markNormalized(rawId: UUID): Promise<void>;
}

export class InMemoryRawGithubRepoStore implements RawGithubRepoStore {
  private readonly byRepoId = new Map<number, { rawId: UUID; record: RawGithubRepoMatch }>();
  private readonly byRawId = new Map<
    UUID,
    { record: RawGithubRepoMatch; normalizedAt: string | null }
  >();

  async insert(record: RawGithubRepoMatch): Promise<{ rawId: UUID; existed: boolean }> {
    const existing = this.byRepoId.get(record.repoId);
    if (existing) {
      this.byRepoId.set(record.repoId, { rawId: existing.rawId, record });
      const entry = this.byRawId.get(existing.rawId);
      if (entry) entry.record = record;
      return { rawId: existing.rawId, existed: true };
    }
    const rawId: UUID = randomUUID();
    this.byRepoId.set(record.repoId, { rawId, record });
    this.byRawId.set(rawId, { record, normalizedAt: null });
    return { rawId, existed: false };
  }

  async getById(rawId: UUID): Promise<RawGithubRepoMatch | null> {
    return this.byRawId.get(rawId)?.record ?? null;
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const entry = this.byRawId.get(rawId);
    if (entry) entry.normalizedAt = new Date().toISOString();
  }

  list(): RawGithubRepoMatch[] {
    return [...this.byRepoId.values()].map((v) => v.record);
  }

  size(): number {
    return this.byRepoId.size;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface GithubRepoSearchAdapterOptions {
  client: GithubClient;
  store?: RawGithubRepoStore;
  search?: RepoSearchOptions;
  retryOptions?: RetryOptions;
  now?: () => Date;
}

export class GithubRepoSearchAdapter extends BaseSourceAdapter<RawGithubRepoMatch> {
  readonly sourceName = 'github-repo-search';
  readonly rateLimit: RateLimitConfig = RATE_LIMIT_GITHUB;

  protected readonly client: GithubClient;
  protected readonly store: RawGithubRepoStore;
  protected readonly searchOptions: Required<
    Pick<RepoSearchOptions, 'repoQuery' | 'maxRepoPages' | 'maxCodePages' | 'perPage' | 'sort'>
  > & { codeQuery: string | null };
  protected readonly clock: () => Date;
  protected readonly adapterLog: Logger;

  constructor(options: GithubRepoSearchAdapterOptions) {
    super(options.retryOptions ?? { maxAttempts: 3 });
    this.client = options.client;
    this.store = options.store ?? new InMemoryRawGithubRepoStore();
    this.searchOptions = {
      repoQuery: options.search?.repoQuery ?? DEFAULT_REPO_QUERY,
      codeQuery:
        options.search?.codeQuery === undefined ? DEFAULT_CODE_QUERY : options.search?.codeQuery,
      maxRepoPages: options.search?.maxRepoPages ?? 1,
      maxCodePages: options.search?.maxCodePages ?? 1,
      perPage: options.search?.perPage ?? 30,
      sort: options.search?.sort ?? 'updated',
    };
    this.clock = options.now ?? (() => new Date());
    this.adapterLog = logger.child({ adapter: 'github-repo-search' });
  }

  override idempotencyKey(record: RawGithubRepoMatch): string {
    return `github:repo:${record.repoId}`;
  }

  /**
   * Single-page fetch: run the configured search queries, dedupe by repo
   * id, hydrate READMEs, score relevance, return one raw record per repo.
   */
  protected override async fetchPage(
    _cursor: Cursor | undefined,
  ): Promise<{ items: RawGithubRepoMatch[]; next?: Cursor }> {
    const reposByFullName = new Map<string, GithubRepoResponse>();
    const codeOnlyFullNames = new Set<string>();

    // Pass 1: search/repositories (metadata hits)
    for (let page = 1; page <= this.searchOptions.maxRepoPages; page += 1) {
      const result = await this.client.searchRepositories(this.searchOptions.repoQuery, {
        perPage: this.searchOptions.perPage,
        page,
        sort: this.searchOptions.sort,
      });
      for (const repo of result.items) {
        reposByFullName.set(repo.full_name, repo);
      }
      if (result.items.length < this.searchOptions.perPage) break;
    }

    // Pass 2 (optional): search/code (code-only hits)
    if (this.searchOptions.codeQuery !== null) {
      for (let page = 1; page <= this.searchOptions.maxCodePages; page += 1) {
        try {
          const result = await this.client.searchCodeRepos(this.searchOptions.codeQuery, {
            perPage: this.searchOptions.perPage,
            page,
          });
          for (const fullName of result.repoFullNames) {
            if (!reposByFullName.has(fullName)) codeOnlyFullNames.add(fullName);
          }
          if (result.repoFullNames.length < this.searchOptions.perPage) break;
        } catch (cause) {
          // Code search requires an extra scope on some PATs; the adapter
          // must not crash if it's unavailable.
          this.adapterLog.warn(
            { err: cause, query: this.searchOptions.codeQuery },
            'search/code failed; continuing with metadata-only matches',
          );
          break;
        }
      }
    }

    // Hydrate code-only repos by fetching their metadata.
    for (const fullName of codeOnlyFullNames) {
      const [owner, repoName] = fullName.split('/');
      if (!owner || !repoName) continue;
      try {
        // GitHub's REST contract: GET /repos/:owner/:repo. We call through
        // a typed pseudo-method on the client to keep this layer agnostic.
        const repo = await this.fetchRepoMeta(owner, repoName);
        if (repo) reposByFullName.set(fullName, repo);
      } catch (cause) {
        this.adapterLog.warn(
          { err: cause, full_name: fullName },
          'failed to hydrate code-only repo; skipping',
        );
      }
    }

    this.adapterLog.info(
      {
        repos_discovered: reposByFullName.size,
        code_only: codeOnlyFullNames.size,
      },
      'discovered repos from search pass',
    );

    const items: RawGithubRepoMatch[] = [];
    for (const repo of reposByFullName.values()) {
      if (repo.private) {
        this.adapterLog.warn(
          { full_name: repo.full_name },
          'skipping private repo returned by search',
        );
        continue;
      }
      try {
        const raw = await this.buildRawRecord(repo, codeOnlyFullNames.has(repo.full_name));
        if (raw) items.push(raw);
      } catch (cause) {
        this.adapterLog.warn(
          { err: cause, full_name: repo.full_name },
          'failed to build raw record; skipping',
        );
      }
    }
    return { items };
  }

  /**
   * Fetch the repository metadata for a `code-only` hit. Wrapped in its own
   * method so tests can monkey-patch without reaching into Octokit.
   */
  protected async fetchRepoMeta(owner: string, repo: string): Promise<GithubRepoResponse | null> {
    // The shared client only exposes search + readme; we extend it inline.
    // This keeps the public client surface small.
    interface RepoClient {
      request: (
        route: string,
        params: Record<string, unknown>,
      ) => Promise<{ status: number; data: GithubRepoResponse }>;
    }
    const internal = (this.client as unknown as { octokit: RepoClient }).octokit;
    if (!internal || typeof internal.request !== 'function') return null;
    const { data } = await internal.request('GET /repos/{owner}/{repo}', { owner, repo });
    return data;
  }

  /**
   * Pull the README, compute relevance, and return the durable raw envelope.
   * Returns `null` if the repo is private (defensive) or has zero relevance
   * — those are silently dropped at the adapter layer.
   */
  protected async buildRawRecord(
    repo: GithubRepoResponse,
    codeOnlyHint: boolean,
  ): Promise<RawGithubRepoMatch | null> {
    if (repo.private) return null;
    const readme = await this.client.getReadme(repo.owner.login, repo.name).catch((cause) => {
      this.adapterLog.warn(
        { err: cause, full_name: repo.full_name },
        'failed to fetch README; treating as missing',
      );
      return null;
    });

    const relevance = scoreRelevance({ repo, readme, codeOnlyHint });
    if (relevance.cursorRelevanceScore <= 0) return null;

    const fetchedAt = this.clock().toISOString();
    const repoSnapshot: RawGithubRepoMatch = {
      repoId: repo.id,
      repoNodeId: repo.node_id,
      repo,
      readme,
      relevance,
      fetchedAt,
      payloadHash: '',
    };
    repoSnapshot.payloadHash = computePayloadHash(repoSnapshot);
    return repoSnapshot;
  }

  protected override async persistRaw(record: RawGithubRepoMatch): Promise<{ rawId: UUID }> {
    try {
      const { rawId } = await this.store.insert(record);
      return { rawId };
    } catch (cause) {
      throw new IngestionError(
        'failed to persist raw github repo match',
        'INGESTION_FAILED',
        { repo_id: record.repoId, full_name: record.repo.full_name },
        cause,
      );
    }
  }

  protected override async normalizeRaw(rawId: UUID): Promise<NormalizedRecord[]> {
    const raw = await this.store.getById(rawId);
    if (!raw) {
      throw new NormalizationError('raw github repo not found', 'NORMALIZATION_FAILED', {
        raw_id: rawId,
      });
    }
    const records = normalizeGithubRepoMatch(raw);
    if (records.length > 0) {
      await this.store.markNormalized(rawId).catch((cause: unknown) => {
        this.adapterLog.warn({ err: cause, raw_id: rawId }, 'markNormalized failed');
      });
    }
    return records;
  }
}

/**
 * Score the relevance of one repo from the available signals. Exported so
 * tests can assert the scoring contract directly without spinning up the
 * full adapter.
 */
export function scoreRelevance(input: {
  repo: GithubRepoResponse;
  readme: string | null;
  codeOnlyHint?: boolean;
}): CursorRelevance {
  const { repo, readme } = input;
  const inReadme = mentionsCursor(readme);
  const inRepoMetadata =
    mentionsCursor(repo.name) ||
    mentionsCursor(repo.description) ||
    repo.topics.some((t) => mentionsCursor(t));
  const inCodeOnly = Boolean(input.codeOnlyHint) && !inReadme && !inRepoMetadata;
  return computeCursorRelevance({ inReadme, inRepoMetadata, inCodeOnly });
}

function computePayloadHash(snapshot: RawGithubRepoMatch): string {
  // payloadHash is excluded from its own input so the hash is stable.
  const stripped = { ...snapshot, payloadHash: '' };
  return createHash('sha256').update(canonicalize(stripped)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const obj = value as Record<string, unknown>;
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}
