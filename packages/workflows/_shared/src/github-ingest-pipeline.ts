/**
 * `github-ingest-pipeline` — Phase 2D end-to-end GitHub ingestion.
 *
 * The GitHub adapter has two modes (SPEC.md §5.2.2): profile refresh and
 * repo search. This pipeline runs both, persisting the resulting Person /
 * Artifact / Communication records against Supabase.
 *
 * Graceful degradation: when `GITHUB_TOKEN` is unset, `createGithubClient`
 * returns a `ConfigError`. The pipeline logs and returns zero-counter stats
 * rather than crashing — this matches SPEC.md §5.4 (skipped, not failed).
 */
import {
  GithubProfileAdapter,
  GithubRepoSearchAdapter,
  SupabaseRawGithubProfileStore,
  SupabaseRawGithubRepoStore,
  StaticAmbassadorSource,
  createGithubClient,
  isMissingTokenError,
  type AmbassadorSource,
  type GithubClient,
} from '@atlas/adapter-github';
import {
  logger,
  type AtlasError,
  type ArtifactType,
  type Logger,
  type Metadata,
  type NormalizedRecord,
} from '@atlas/core';
import {
  ArtifactQueries,
  CommunicationQueries,
  PersonQueries,
  getServiceClient,
} from '@atlas/db';
import {
  IdentityResolver,
  SupabasePersonStore,
  SupabaseResolutionAuditStore,
  type NormalizedPersonPayload,
  type PersonStore,
  type ResolutionAuditStore,
  type ResolutionOutcome,
} from '@atlas/intelligence-identity-resolution';
import { inngest } from './inngest-client.js';

const ARTIFACT_TYPES: ReadonlySet<ArtifactType> = new Set([
  'workshop_recording',
  'hackathon_submission',
  'demo_video',
  'rules_template',
  'mcp_config',
  'agent_definition',
  'blog_post',
  'documentation',
  'tutorial',
  'case_study',
]);

const FALLBACK_AMBASSADOR_LOGINS = [
  'getcursor',
  'cursorinsight',
  'anysphere',
];

export interface GithubIngestStats {
  // Profile mode
  profiles_discovered: number;
  profiles_raw_inserted: number;
  profiles_raw_existed: number;
  profiles_normalized: number;
  // Repo mode
  repos_discovered: number;
  repos_raw_inserted: number;
  repos_raw_existed: number;
  repos_normalized: number;

  raw_persist_failures: number;
  normalize_failures: number;

  persons_created: number;
  persons_merged: number;
  persons_skipped: number;
  persons_human_review: number;
  person_resolve_failures: number;

  artifacts_created: number;
  artifact_failures: number;

  communications_upserted: number;
  communication_upsert_failures: number;

  mentions_edges_created: number;
  mentions_edge_failures: number;

  /** True when GITHUB_TOKEN was not set and the run was skipped. */
  skipped_no_token: boolean;
}

function emptyStats(): GithubIngestStats {
  return {
    profiles_discovered: 0,
    profiles_raw_inserted: 0,
    profiles_raw_existed: 0,
    profiles_normalized: 0,
    repos_discovered: 0,
    repos_raw_inserted: 0,
    repos_raw_existed: 0,
    repos_normalized: 0,
    raw_persist_failures: 0,
    normalize_failures: 0,
    persons_created: 0,
    persons_merged: 0,
    persons_skipped: 0,
    persons_human_review: 0,
    person_resolve_failures: 0,
    artifacts_created: 0,
    artifact_failures: 0,
    communications_upserted: 0,
    communication_upsert_failures: 0,
    mentions_edges_created: 0,
    mentions_edge_failures: 0,
    skipped_no_token: false,
  };
}

export interface GithubIngestDeps {
  /** Inject a GithubClient for tests. Production reads `GITHUB_TOKEN`. */
  client?: GithubClient;
  /** Inject an ambassador source. Production reads from `person_platform_identity`. */
  ambassadors?: AmbassadorSource;
  resolver?: IdentityResolver;
  personStore?: PersonStore;
  auditStore?: ResolutionAuditStore;
  /** Cap on profiles to refresh (for smoke tests). */
  profileLimit?: number;
  /** Cap on repo-search items to process (for smoke tests). */
  repoLimit?: number;
  logger?: Logger;
}

/**
 * Default ambassador source: reads GitHub handles from
 * `person_platform_identity` where `platform = 'github'`. Falls back to a
 * small static list when the table is empty (the first run of the pipeline).
 */
class SupabaseAmbassadorSource implements AmbassadorSource {
  async list(): Promise<string[]> {
    const svc = getServiceClient();
    if (!svc.ok) return [...FALLBACK_AMBASSADOR_LOGINS];
    const result = await svc.value
      .from('person_platform_identity')
      .select('handle')
      .eq('platform', 'github');
    if (result.error) return [...FALLBACK_AMBASSADOR_LOGINS];
    const handles = ((result.data ?? []) as Array<{ handle: string }>)
      .map((r) => r.handle.trim().toLowerCase())
      .filter((h) => h.length > 0);
    return handles.length > 0 ? [...new Set(handles)] : [...FALLBACK_AMBASSADOR_LOGINS];
  }
}

async function runProfileMode(
  deps: {
    client: GithubClient;
    ambassadors: AmbassadorSource;
    resolver: IdentityResolver;
    log: Logger;
    profileLimit: number | undefined;
  },
  stats: GithubIngestStats,
): Promise<void> {
  const rawStore = new SupabaseRawGithubProfileStore();
  const adapter = new GithubProfileAdapter({
    client: deps.client,
    ambassadors: deps.ambassadors,
    store: rawStore,
  });

  // Phase 1: fetch + persist raw
  const persisted: Array<{ rawId: string; login: string }> = [];
  for await (const raw of adapter.fetch()) {
    stats.profiles_discovered += 1;
    try {
      const { rawId, existed } = await rawStore.insert(raw);
      if (existed) stats.profiles_raw_existed += 1;
      else stats.profiles_raw_inserted += 1;
      persisted.push({ rawId, login: raw.login });
    } catch (cause) {
      stats.raw_persist_failures += 1;
      deps.log.warn({ err: cause, login: raw.login }, 'failed to persist raw profile');
    }
    if (deps.profileLimit !== undefined && persisted.length >= deps.profileLimit) break;
  }

  // Phase 2 + 3: normalize + resolve person
  for (const item of persisted) {
    let records: NormalizedRecord[] = [];
    try {
      records = await adapter.normalize(item.rawId);
      stats.profiles_normalized += records.length;
    } catch (cause) {
      stats.normalize_failures += 1;
      await rawStore.markFailed(item.rawId, formatErr(cause)).catch(() => undefined);
      deps.log.warn({ err: cause, login: item.login }, 'profile normalization failed');
      continue;
    }
    for (const record of records.filter((r) => r.recordType === 'person')) {
      await resolvePerson(record, deps.resolver, stats, deps.log);
    }
  }

  deps.log.info(
    {
      profiles_discovered: stats.profiles_discovered,
      profiles_raw_inserted: stats.profiles_raw_inserted,
      profiles_normalized: stats.profiles_normalized,
    },
    'profile mode complete',
  );
}

async function runRepoSearchMode(
  deps: {
    client: GithubClient;
    resolver: IdentityResolver;
    log: Logger;
    repoLimit: number | undefined;
  },
  stats: GithubIngestStats,
): Promise<void> {
  const rawStore = new SupabaseRawGithubRepoStore();
  const adapter = new GithubRepoSearchAdapter({
    client: deps.client,
    store: rawStore,
  });

  const persisted: Array<{ rawId: string; repoId: number; fullName: string }> = [];
  for await (const raw of adapter.fetch()) {
    stats.repos_discovered += 1;
    try {
      const { rawId, existed } = await rawStore.insert(raw);
      if (existed) stats.repos_raw_existed += 1;
      else stats.repos_raw_inserted += 1;
      persisted.push({ rawId, repoId: raw.repoId, fullName: raw.repo.full_name });
    } catch (cause) {
      stats.raw_persist_failures += 1;
      deps.log.warn({ err: cause, repo_id: raw.repoId }, 'failed to persist raw repo');
    }
    if (deps.repoLimit !== undefined && persisted.length >= deps.repoLimit) break;
  }

  for (const item of persisted) {
    let records: NormalizedRecord[] = [];
    try {
      records = await adapter.normalize(item.rawId);
      stats.repos_normalized += records.length;
    } catch (cause) {
      stats.normalize_failures += 1;
      await rawStore.markFailed(item.rawId, formatErr(cause)).catch(() => undefined);
      deps.log.warn({ err: cause, repo: item.fullName }, 'repo normalization failed');
      continue;
    }

    // Resolve the repo owner first so the Artifact / Communication can be
    // attributed to a Person.
    let ownerPersonId: string | null = null;
    for (const personRecord of records.filter((r) => r.recordType === 'person')) {
      ownerPersonId = await resolvePerson(personRecord, deps.resolver, stats, deps.log);
      if (ownerPersonId) break;
    }

    // Artifact
    for (const artifactRecord of records.filter((r) => r.recordType === 'artifact')) {
      const payload = artifactRecord.payload as GithubArtifactPayload;
      const artifactType: ArtifactType = ARTIFACT_TYPES.has(
        (payload.artifact_type ?? 'documentation') as ArtifactType,
      )
        ? (payload.artifact_type as ArtifactType)
        : 'documentation';
      const result = await ArtifactQueries.createArtifact({
        artifact_type: artifactType,
        title: payload.title ?? `github:${item.repoId}`,
        creator_person_id: ownerPersonId,
        derived_from_event_id: null,
        content_url: payload.content_url ?? null,
        content_text: payload.readme_excerpt ?? null,
        vertical_tags: [],
        technical_tags: payload.technical_tags ?? [],
        is_public: true,
        quality_score: payload.cursor_relevance_score ?? null,
        metadata: {
          repo_id: payload.repo_id,
          repo_node_id: payload.repo_node_id,
          repo_full_name: payload.repo_full_name,
          owner_login: payload.owner_login,
          stargazers_count: payload.stargazers_count,
          forks_count: payload.forks_count,
          language: payload.language,
          source: 'github',
        },
      });
      if (!result.ok) {
        // Duplicates: silently skip
        const code = (result.error.context as Record<string, unknown>)['pgrstCode'];
        if (code === '23505') {
          // already exists — treat as success
          stats.artifacts_created += 0;
        } else {
          stats.artifact_failures += 1;
          deps.log.warn({ err: result.error, repo: item.fullName }, 'artifact insert failed');
        }
      } else {
        stats.artifacts_created += 1;
      }
    }

    // Communication (README mention) — the normalizer puts source_platform
    // as 'forum' in the inner payload because SPEC.md's `communication` CHECK
    // list does not include 'github'.
    for (const commRecord of records.filter((r) => r.recordType === 'communication')) {
      const payload = commRecord.payload as GithubCommunicationPayload;
      const result = await CommunicationQueries.createCommunication({
        source_platform: 'forum',
        source_record_id: commRecord.sourceRecordId,
        author_person_id: ownerPersonId,
        author_handle_raw: payload.author_handle_raw ?? '',
        content_text: payload.content_text ?? '',
        content_url: payload.content_url ?? null,
        posted_at: (payload.posted_at as string) ?? (commRecord.observedAt as string),
        sentiment_score: null,
        topic_tags: payload.topic_tags ?? [],
        vertical_tags: [],
        engagement_likes: 0,
        engagement_replies: 0,
        engagement_shares: 0,
        engagement_views: null,
        is_about_cursor: payload.is_about_cursor ?? true,
        cursor_relevance_score: payload.cursor_relevance_score ?? null,
      });
      if (!result.ok) {
        stats.communication_upsert_failures += 1;
        deps.log.warn(
          { err: result.error, repo: item.fullName },
          'github readme communication upsert failed',
        );
      } else {
        stats.communications_upserted += 1;
      }
    }
  }

  deps.log.info(
    {
      repos_discovered: stats.repos_discovered,
      repos_raw_inserted: stats.repos_raw_inserted,
      repos_normalized: stats.repos_normalized,
      artifacts_created: stats.artifacts_created,
      communications_upserted: stats.communications_upserted,
    },
    'repo-search mode complete',
  );
}

interface GithubArtifactPayload extends Metadata {
  artifact_type?: string;
  title?: string;
  content_url?: string | null;
  readme_excerpt?: string | null;
  technical_tags?: string[];
  cursor_relevance_score?: number | null;
  repo_id?: number;
  repo_node_id?: string;
  repo_full_name?: string;
  owner_login?: string;
  language?: string | null;
  stargazers_count?: number;
  forks_count?: number;
}

interface GithubCommunicationPayload extends Metadata {
  source_platform?: string;
  source_record_id?: string;
  author_handle_raw?: string;
  content_text?: string;
  content_url?: string | null;
  posted_at?: string;
  is_about_cursor?: boolean;
  cursor_relevance_score?: number | null;
  topic_tags?: string[];
}

interface GithubPersonPayload extends Metadata {
  canonical_name?: string;
  names_seen?: string[];
  github_login?: string;
  github_user_id?: number;
  github_profile_url?: string;
  bio?: string | null;
  blog?: string | null;
  location?: string | null;
  primary_email?: string | null;
  follower_count?: number;
  platform_identities?: Array<{
    platform: 'github' | 'twitter' | 'linkedin' | 'email';
    handle: string;
    profile_url: string | null;
    follower_count?: number;
  }>;
}

function toResolverPersonRecord(
  record: NormalizedRecord,
): NormalizedRecord<NormalizedPersonPayload> & { recordType: 'person' } {
  const src = record.payload as GithubPersonPayload;
  const identities = src.platform_identities ?? [];
  const github = identities.find((p) => p.platform === 'github');
  const primary = github ?? identities[0];

  const bioLinks: NormalizedPersonPayload['bioLinks'] = {};
  for (const ident of identities) {
    if (ident === primary) continue;
    if (ident.platform === 'github') bioLinks.github = ident.handle;
    else if (ident.platform === 'twitter') bioLinks.twitter = ident.handle;
    else if (ident.platform === 'linkedin') bioLinks.linkedin = ident.handle;
  }

  const emails: string[] = [];
  if (src.primary_email) emails.push(src.primary_email.toLowerCase());
  for (const ident of identities) {
    if (ident.platform === 'email') emails.push(ident.handle.toLowerCase());
  }

  const payload: NormalizedPersonPayload = {
    canonicalName: src.canonical_name,
    namesSeen: src.names_seen ?? (src.canonical_name ? [src.canonical_name] : []),
    bioLinks,
    metadata: {
      github_login: src.github_login ?? null,
      github_profile_url: src.github_profile_url ?? null,
      bio: src.bio ?? null,
      location: src.location ?? null,
      source: 'github',
    },
  };
  if (emails.length > 0) {
    payload.emails = [...new Set(emails)];
    if (src.primary_email) payload.primaryEmail = src.primary_email.toLowerCase();
  }
  if (primary) {
    payload.platformIdentity = {
      platform: primary.platform,
      handle: primary.handle,
    };
    if (primary.profile_url) payload.platformIdentity.profileUrl = primary.profile_url;
    if (typeof primary.follower_count === 'number')
      payload.platformIdentity.followerCount = primary.follower_count;
  }

  return {
    recordType: 'person',
    sourcePlatform: record.sourcePlatform,
    sourceRecordId: record.sourceRecordId,
    payload,
    observedAt: record.observedAt,
  };
}

async function resolvePerson(
  record: NormalizedRecord,
  resolver: IdentityResolver,
  stats: GithubIngestStats,
  log: Logger,
): Promise<string | null> {
  const transformed = toResolverPersonRecord(record);
  try {
    const r = await resolver.resolve(transformed);
    if (!r.ok) {
      stats.person_resolve_failures += 1;
      log.warn({ err: r.error, source_id: transformed.sourceRecordId }, 'resolver err');
      return null;
    }
    bumpOutcomeCounts(stats, r.value);
    return r.value.personId;
  } catch (cause) {
    stats.person_resolve_failures += 1;
    log.warn(
      { err: cause, source_id: transformed.sourceRecordId },
      'identity resolution threw',
    );
    return null;
  }
}

function bumpOutcomeCounts(stats: GithubIngestStats, outcome: ResolutionOutcome): void {
  switch (outcome.action) {
    case 'merge':
      stats.persons_merged += 1;
      break;
    case 'create_new':
      stats.persons_created += 1;
      break;
    case 'human_review':
      stats.persons_human_review += 1;
      break;
    case 'skip':
      stats.persons_skipped += 1;
      break;
  }
}

export async function runGithubIngest(deps: GithubIngestDeps = {}): Promise<GithubIngestStats> {
  const log = deps.logger ?? logger.child({ workflow: 'github-ingest-pipeline' });
  const stats = emptyStats();

  let client: GithubClient;
  if (deps.client) {
    client = deps.client;
  } else {
    const r = createGithubClient();
    if (!r.ok) {
      if (isMissingTokenError(r.error)) {
        log.warn('GITHUB_TOKEN not set — skipping github ingest gracefully');
        stats.skipped_no_token = true;
        return stats;
      }
      throw r.error;
    }
    client = r.value;
  }

  const ambassadors = deps.ambassadors ?? new SupabaseAmbassadorSource();
  const personStore = deps.personStore ?? new SupabasePersonStore();
  const auditStore = deps.auditStore ?? new SupabaseResolutionAuditStore();
  const resolver =
    deps.resolver ??
    new IdentityResolver({ store: personStore, audit: auditStore, logger: log });

  try {
    await runProfileMode(
      { client, ambassadors, resolver, log, profileLimit: deps.profileLimit },
      stats,
    );
  } catch (cause) {
    log.warn({ err: cause }, 'profile mode failed; continuing to repo-search');
  }

  try {
    await runRepoSearchMode(
      { client, resolver, log, repoLimit: deps.repoLimit },
      stats,
    );
  } catch (cause) {
    log.warn({ err: cause }, 'repo-search mode failed');
  }

  log.info(stats, 'github-ingest-pipeline finished');
  return stats;
}

export const githubIngestPipeline = inngest.createFunction(
  { id: 'github-ingest-pipeline', name: 'GitHub — end-to-end ingest pipeline' },
  { cron: '0 0 * * *' },
  async ({ step }) => {
    return step.run('run', () => runGithubIngest());
  },
);

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

// Use the StaticAmbassadorSource type for tests that need to inject a list.
export { StaticAmbassadorSource };
export type { AtlasError };
