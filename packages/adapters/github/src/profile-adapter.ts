/**
 * GithubProfileAdapter — refreshes public profiles for known ambassadors.
 *
 * SPEC.md §5.2.2: "Schedule: Weekly per known ambassador." The adapter
 * iterates over a list of GitHub logins supplied by an
 * {@link AmbassadorSource} (the production source reads
 * `person_platform_identity` rows where `platform = 'github'`; tests inject
 * a {@link StaticAmbassadorSource}). For each login it pulls the public
 * profile + the top N most recently pushed repos and emits a {@link RawGithubProfile}.
 *
 * Persistence boundary: the task brief constrains us to in-memory stores in
 * this PR. The default store is {@link InMemoryRawGithubProfileStore}; the
 * Supabase-backed store will land alongside `packages/db/queries/profile.ts`
 * in a follow-up.
 *
 * @example
 * ```ts
 * const adapter = new GithubProfileAdapter({
 *   ambassadors: new StaticAmbassadorSource(['alicechen', 'brunot']),
 *   client,
 * });
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
import type { GithubClient } from './client.js';
import { normalizeGithubProfile } from './normalizer.js';
import type { AmbassadorSource, RawGithubProfile } from './types.js';

// ---------------------------------------------------------------------------
// Storage abstraction
// ---------------------------------------------------------------------------

/**
 * Storage abstraction over the `raw_github_profile` table. The in-memory
 * implementation is wired for tests and the CLI; a Supabase-backed store
 * arrives once `packages/db/queries/github.ts` exposes the helpers.
 */
export interface RawGithubProfileStore {
  /** Insert one raw profile. Idempotent on `login`: re-inserts overwrite the row but return the same `rawId`. */
  insert(record: RawGithubProfile): Promise<{ rawId: UUID; existed: boolean }>;
  /** Read back a stored profile by id. */
  getById(rawId: UUID): Promise<RawGithubProfile | null>;
  /** Mark a raw row as normalized so we don't re-emit downstream events. */
  markNormalized(rawId: UUID): Promise<void>;
}

export class InMemoryRawGithubProfileStore implements RawGithubProfileStore {
  private readonly byLogin = new Map<string, { rawId: UUID; record: RawGithubProfile }>();
  private readonly byRawId = new Map<
    UUID,
    { record: RawGithubProfile; normalizedAt: string | null }
  >();

  async insert(record: RawGithubProfile): Promise<{ rawId: UUID; existed: boolean }> {
    const existing = this.byLogin.get(record.login);
    if (existing) {
      // Overwrite the payload (a refresh is the whole point) but keep rawId stable.
      this.byLogin.set(record.login, { rawId: existing.rawId, record });
      const entry = this.byRawId.get(existing.rawId);
      if (entry) entry.record = record;
      return { rawId: existing.rawId, existed: true };
    }
    const rawId: UUID = randomUUID();
    this.byLogin.set(record.login, { rawId, record });
    this.byRawId.set(rawId, { record, normalizedAt: null });
    return { rawId, existed: false };
  }

  async getById(rawId: UUID): Promise<RawGithubProfile | null> {
    return this.byRawId.get(rawId)?.record ?? null;
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const entry = this.byRawId.get(rawId);
    if (entry) entry.normalizedAt = new Date().toISOString();
  }

  list(): RawGithubProfile[] {
    return [...this.byLogin.values()].map((v) => v.record);
  }

  size(): number {
    return this.byLogin.size;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface GithubProfileAdapterOptions {
  /** Source of ambassador GitHub logins. Required. */
  ambassadors: AmbassadorSource;
  /** Authenticated GitHub client. Required. */
  client: GithubClient;
  /** Override the raw store. Defaults to a fresh in-memory store. */
  store?: RawGithubProfileStore;
  /** Override retry policy. */
  retryOptions?: RetryOptions;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
  /** Number of top repos to attach to each profile. Defaults to 10 (SPEC.md §5.2.2 "top repos"). */
  topRepoCount?: number;
}

export class GithubProfileAdapter extends BaseSourceAdapter<RawGithubProfile> {
  readonly sourceName = 'github-profile';
  readonly rateLimit: RateLimitConfig = RATE_LIMIT_GITHUB;

  protected readonly ambassadors: AmbassadorSource;
  protected readonly client: GithubClient;
  protected readonly store: RawGithubProfileStore;
  protected readonly clock: () => Date;
  protected readonly topRepoCount: number;
  protected readonly adapterLog: Logger;

  constructor(options: GithubProfileAdapterOptions) {
    super(options.retryOptions ?? { maxAttempts: 3 });
    this.ambassadors = options.ambassadors;
    this.client = options.client;
    this.store = options.store ?? new InMemoryRawGithubProfileStore();
    this.clock = options.now ?? (() => new Date());
    this.topRepoCount = options.topRepoCount ?? 10;
    this.adapterLog = logger.child({ adapter: 'github-profile' });
  }

  override idempotencyKey(record: RawGithubProfile): string {
    return `github:profile:${record.login}`;
  }

  /**
   * Single-page fetch: pull every ambassador login, return one raw record per
   * login. Per-login errors are logged and skipped so a single bad login
   * never aborts the run.
   */
  protected override async fetchPage(
    _cursor: Cursor | undefined,
  ): Promise<{ items: RawGithubProfile[]; next?: Cursor }> {
    const logins = await this.ambassadors.list();
    this.adapterLog.info({ ambassador_count: logins.length }, 'refreshing ambassador profiles');

    const items: RawGithubProfile[] = [];
    for (const login of logins) {
      try {
        const raw = await this.fetchOne(login);
        items.push(raw);
      } catch (cause) {
        this.adapterLog.warn(
          { err: cause, login },
          'failed to refresh ambassador profile; skipping',
        );
      }
    }
    return { items };
  }

  /** Fetch one ambassador's profile + top repos and wrap into a raw envelope. */
  protected async fetchOne(login: string): Promise<RawGithubProfile> {
    const normalizedLogin = login.trim().toLowerCase();
    if (!normalizedLogin) {
      throw new IngestionError(
        'github-profile: empty login from ambassador source',
        'INGESTION_FAILED',
        { login },
      );
    }
    const profile = await this.client.getProfile(normalizedLogin);
    // Even a user with no public activity has zero repos; we still emit a
    // profile record so identity resolution can link the bio.
    const topRepos = await this.client.listUserRepos(normalizedLogin, this.topRepoCount);
    const fetchedAt = this.clock().toISOString();
    const payloadHash = computePayloadHash({ profile, topRepos });
    return {
      login: normalizedLogin,
      profile,
      topRepos,
      fetchedAt,
      payloadHash,
    };
  }

  protected override async persistRaw(record: RawGithubProfile): Promise<{ rawId: UUID }> {
    try {
      const { rawId } = await this.store.insert(record);
      return { rawId };
    } catch (cause) {
      throw new IngestionError(
        'failed to persist raw github profile',
        'INGESTION_FAILED',
        { login: record.login },
        cause,
      );
    }
  }

  protected override async normalizeRaw(rawId: UUID): Promise<NormalizedRecord[]> {
    const raw = await this.store.getById(rawId);
    if (!raw) {
      throw new NormalizationError('raw github profile not found', 'NORMALIZATION_FAILED', {
        raw_id: rawId,
      });
    }
    const records = normalizeGithubProfile(raw);
    if (records.length > 0) {
      await this.store.markNormalized(rawId).catch((cause: unknown) => {
        this.adapterLog.warn({ err: cause, raw_id: rawId }, 'markNormalized failed');
      });
    }
    return records;
  }
}

/**
 * SHA-256 hex digest over a stable JSON serialization of the snapshot.
 * Field ordering is deterministic so two refreshes with identical content
 * produce identical hashes.
 */
function computePayloadHash(snapshot: { profile: unknown; topRepos: unknown }): string {
  return createHash('sha256').update(canonicalize(snapshot)).digest('hex');
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
