/**
 * GitHub normalizer — converts raw GitHub records into `NormalizedRecord[]`.
 *
 * Two entry points, one per adapter mode (SPEC.md §5.2.2):
 *
 *   - {@link normalizeGithubProfile} — emits exactly one Person record per
 *     refreshed ambassador profile.
 *
 *   - {@link normalizeGithubRepoMatch} — emits one Artifact + one Person
 *     (the repo owner) + optionally one Communication (the README text when
 *     it mentions Cursor) for each Cursor-related repository.
 *
 * Edge synthesis (person_platform_identity, communication_mentions_*) is
 * NOT performed here — identity resolution owns it (SPEC.md §4.3). This
 * keeps the adapter agnostic of resolution policy.
 *
 * Normalization is deterministic: the same raw payload always produces the
 * same array of NormalizedRecord, byte-for-byte. The adapter tests rely on
 * this.
 */

import { logger, type Metadata, type NormalizedRecord } from '@atlas/core';
import type { RawGithubProfile, RawGithubRepoMatch } from './types.js';

const log = logger.child({ adapter: 'github', component: 'normalizer' });

const SOURCE_PLATFORM_GITHUB = 'github';

// ---------------------------------------------------------------------------
// Cursor mention detection
// ---------------------------------------------------------------------------

/**
 * Case-insensitive, word-aware "cursor" detector.
 *
 * Matches `cursor`, `Cursor`, `CURSOR`, `@cursor`, `cursor.com`, `cursorIDE`,
 * `cursor-ai`, etc. Avoids matching tokens like `cursors` only by accident;
 * substring `cursor` inside larger words still counts as a mention because
 * in practice that is how the editor name appears in code samples.
 *
 * We intentionally do not try to disambiguate "database cursor" from the
 * editor. False positives are tolerable at this stage because downstream
 * sentiment/topic classification will re-rank.
 */
export function mentionsCursor(text: string | null | undefined): boolean {
  if (!text) return false;
  return /cursor/i.test(text);
}

// ---------------------------------------------------------------------------
// Profile mode
// ---------------------------------------------------------------------------

/**
 * Convert one refreshed ambassador profile into a Person `NormalizedRecord`.
 *
 * The payload includes a `platform_identities` array containing the GitHub
 * identity plus best-effort bio-link extraction (twitter, linkedin) so the
 * identity resolver can link this Person to records from other sources.
 *
 * @example
 * ```ts
 * const records = normalizeGithubProfile(raw);
 * const person = records.find((r) => r.recordType === 'person');
 * ```
 */
export function normalizeGithubProfile(raw: RawGithubProfile): NormalizedRecord[] {
  if (!raw.login) {
    log.warn({ fetched_at: raw.fetchedAt }, 'dropping raw profile with empty login');
    return [];
  }
  const profile = raw.profile;
  const canonicalName = profile.name?.trim() || raw.login;
  const platformIdentities = buildProfileIdentities(raw);
  const topRepoTags = topRepoSummary(raw);

  const payload: Metadata = {
    canonical_name: canonicalName,
    names_seen: profile.name ? [profile.name, raw.login] : [raw.login],
    github_login: raw.login,
    github_user_id: profile.id,
    github_profile_url: profile.html_url,
    bio: profile.bio,
    company: profile.company,
    blog: profile.blog,
    location: profile.location,
    primary_email: profile.email,
    avatar_url: profile.avatar_url,
    follower_count: profile.followers,
    following_count: profile.following,
    public_repo_count: profile.public_repos,
    platform_identities: platformIdentities,
    top_repos: topRepoTags,
    observed_role: 'ambassador_candidate',
    source_mode: 'profile_refresh',
    payload_hash: raw.payloadHash,
  };

  return [
    {
      recordType: 'person',
      sourcePlatform: SOURCE_PLATFORM_GITHUB,
      sourceRecordId: raw.login,
      payload,
      observedAt: raw.fetchedAt,
    },
  ];
}

interface PlatformIdentityPayload {
  platform: 'github' | 'twitter' | 'linkedin' | 'email';
  handle: string;
  profile_url: string | null;
  /** Source-specific extras (e.g. follower count for the GitHub identity). */
  follower_count?: number;
}

function buildProfileIdentities(raw: RawGithubProfile): PlatformIdentityPayload[] {
  const out: PlatformIdentityPayload[] = [];
  out.push({
    platform: 'github',
    handle: raw.login,
    profile_url: raw.profile.html_url,
    follower_count: raw.profile.followers,
  });
  if (raw.profile.twitter_username) {
    out.push({
      platform: 'twitter',
      handle: raw.profile.twitter_username,
      profile_url: `https://twitter.com/${raw.profile.twitter_username}`,
    });
  }
  // Best-effort: bio occasionally contains a linkedin.com/in/<handle> URL.
  const linkedin =
    extractLinkedinHandle(raw.profile.bio) ?? extractLinkedinHandle(raw.profile.blog);
  if (linkedin) {
    out.push({
      platform: 'linkedin',
      handle: linkedin,
      profile_url: `https://www.linkedin.com/in/${linkedin}`,
    });
  }
  if (raw.profile.email) {
    out.push({
      platform: 'email',
      handle: raw.profile.email.toLowerCase(),
      profile_url: null,
    });
  }
  return dedupeIdentities(out);
}

function extractLinkedinHandle(text: string | null): string | null {
  if (!text) return null;
  // Match `linkedin.com/in/<handle>` where `<handle>` is a sequence of
  // alphanumerics, underscores, or hyphens, optionally separated by single
  // dots. Trailing punctuation (period, comma, parenthesis) is excluded.
  const match = /linkedin\.com\/in\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/i.exec(text);
  return match?.[1] ?? null;
}

function dedupeIdentities(items: PlatformIdentityPayload[]): PlatformIdentityPayload[] {
  const seen = new Map<string, PlatformIdentityPayload>();
  for (const item of items) {
    const key = `${item.platform}:${item.handle.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

interface TopRepoTag {
  name: string;
  full_name: string;
  stars: number;
  language: string | null;
  pushed_at: string | null;
  is_fork: boolean;
}

function topRepoSummary(raw: RawGithubProfile): TopRepoTag[] {
  return raw.topRepos
    .filter((r) => !r.private)
    .map((r) => ({
      name: r.name,
      full_name: r.full_name,
      stars: r.stargazers_count,
      language: r.language,
      pushed_at: r.pushed_at,
      is_fork: r.fork,
    }));
}

// ---------------------------------------------------------------------------
// Repo-search mode
// ---------------------------------------------------------------------------

/**
 * Convert one Cursor-related repository match into:
 *   - 1 Artifact (the repo itself, type=`documentation`)
 *   - 1 Person (the repo owner)
 *   - 1 Communication (the README content) when the README mentions Cursor
 *
 * Private repos and archived/empty repos are filtered out at the adapter
 * layer (`storeRaw` rejects them); this function additionally guards against
 * the `private: true` field as a defensive check.
 *
 * @example
 * ```ts
 * const records = normalizeGithubRepoMatch(rawMatch);
 * const artifacts = records.filter((r) => r.recordType === 'artifact');
 * const persons = records.filter((r) => r.recordType === 'person');
 * ```
 */
export function normalizeGithubRepoMatch(raw: RawGithubRepoMatch): NormalizedRecord[] {
  if (raw.repo.private) {
    log.warn({ repo_id: raw.repoId, full_name: raw.repo.full_name }, 'skipping private repo');
    return [];
  }
  if (raw.relevance.cursorRelevanceScore <= 0) {
    log.warn(
      { repo_id: raw.repoId, full_name: raw.repo.full_name },
      'skipping repo with zero cursor relevance',
    );
    return [];
  }
  const observedAt = raw.fetchedAt;
  const out: NormalizedRecord[] = [];
  out.push(buildArtifactRecord(raw, observedAt));
  out.push(buildOwnerPersonRecord(raw, observedAt));
  const comm = buildReadmeCommunicationRecord(raw, observedAt);
  if (comm) out.push(comm);
  return out;
}

function buildArtifactRecord(raw: RawGithubRepoMatch, observedAt: string): NormalizedRecord {
  const repo = raw.repo;
  const description = repo.description;
  const technicalTags = uniqueLowerCase([
    ...(repo.language ? [repo.language] : []),
    ...repo.topics,
  ]);
  const payload: Metadata = {
    artifact_type: deriveArtifactType(raw),
    title: repo.full_name,
    description,
    content_url: repo.html_url,
    repo_id: raw.repoId,
    repo_node_id: raw.repoNodeId,
    repo_full_name: repo.full_name,
    owner_login: repo.owner.login,
    language: repo.language,
    technical_tags: technicalTags,
    stargazers_count: repo.stargazers_count,
    forks_count: repo.forks_count,
    is_fork: repo.fork,
    is_archived: repo.archived,
    pushed_at: repo.pushed_at,
    created_at: repo.created_at,
    cursor_relevance_score: raw.relevance.cursorRelevanceScore,
    cursor_relevance: raw.relevance,
    readme_excerpt: raw.readme ? excerpt(raw.readme, 240) : null,
    payload_hash: raw.payloadHash,
    source_mode: 'repo_search',
  };
  return {
    recordType: 'artifact',
    sourcePlatform: SOURCE_PLATFORM_GITHUB,
    sourceRecordId: String(raw.repoId),
    payload,
    observedAt,
  };
}

function deriveArtifactType(raw: RawGithubRepoMatch): string {
  const description = (raw.repo.description ?? '').toLowerCase();
  const topics = raw.repo.topics.map((t) => t.toLowerCase());
  if (topics.includes('mcp') || /mcp\b/.test(description)) return 'mcp_config';
  if (topics.includes('rules') || /\brules\b/.test(description)) return 'rules_template';
  if (topics.includes('agent') || /\bagent\b/.test(description)) return 'agent_definition';
  if (topics.includes('tutorial') || /\btutorial\b/.test(description)) return 'tutorial';
  // SPEC.md §3.2.5 enumerates the closed list. Repos that don't obviously
  // fit one of the specialized buckets land as `documentation`.
  return 'documentation';
}

function buildOwnerPersonRecord(raw: RawGithubRepoMatch, observedAt: string): NormalizedRecord {
  const owner = raw.repo.owner;
  const payload: Metadata = {
    canonical_name: owner.login,
    names_seen: [owner.login],
    github_login: owner.login,
    github_user_id: owner.id,
    github_profile_url: owner.html_url,
    avatar_url: owner.avatar_url,
    owner_type: owner.type,
    platform_identities: [
      {
        platform: 'github',
        handle: owner.login,
        profile_url: owner.html_url,
      },
    ],
    observed_via_repo: raw.repo.full_name,
    source_mode: 'repo_search',
  };
  return {
    recordType: 'person',
    sourcePlatform: SOURCE_PLATFORM_GITHUB,
    sourceRecordId: `repo:${raw.repoId}:owner:${owner.login}`,
    payload,
    observedAt,
  };
}

function buildReadmeCommunicationRecord(
  raw: RawGithubRepoMatch,
  observedAt: string,
): NormalizedRecord | null {
  if (!raw.readme || !raw.relevance.inReadme) return null;
  const payload: Metadata = {
    source_platform: 'forum', // closest fit from SPEC.md §3.2.4 CHECK list; TODO(spec): add 'github' to the closed list
    source_record_id: `github:readme:${raw.repoId}`,
    author_handle_raw: raw.repo.owner.login,
    content_text: raw.readme,
    content_url: `${raw.repo.html_url}#readme`,
    posted_at: raw.repo.pushed_at ?? observedAt,
    is_about_cursor: true,
    cursor_relevance_score: raw.relevance.cursorRelevanceScore,
    topic_tags: ['github_readme'],
    repo_full_name: raw.repo.full_name,
    repo_id: raw.repoId,
  };
  return {
    recordType: 'communication',
    sourcePlatform: SOURCE_PLATFORM_GITHUB,
    sourceRecordId: `github:readme:${raw.repoId}`,
    payload,
    observedAt,
  };
}

function uniqueLowerCase(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Relevance scoring helper (exposed so the adapter can call it before
// persisting raw rows — the adapter must decide whether a repo is worth
// keeping based on its relevance score).
// ---------------------------------------------------------------------------

/**
 * Compute a {@link CursorRelevance} from observed signals. Bands match the
 * documented constants in `./types.ts` and the normalizer above.
 *
 * @example
 * ```ts
 * const relevance = computeCursorRelevance({
 *   inReadme: false,
 *   inRepoMetadata: true,
 *   inCodeOnly: false,
 * });
 * expect(relevance.cursorRelevanceScore).toBe(0.6);
 * ```
 */
export function computeCursorRelevance(input: {
  inReadme: boolean;
  inRepoMetadata: boolean;
  inCodeOnly: boolean;
}): {
  inReadme: boolean;
  inRepoMetadata: boolean;
  inCodeOnly: boolean;
  cursorRelevanceScore: number;
} {
  let score = 0;
  if (input.inReadme) score = Math.max(score, 0.9);
  if (input.inRepoMetadata) score = Math.max(score, 0.6);
  if (input.inCodeOnly && !input.inReadme && !input.inRepoMetadata) score = Math.max(score, 0.3);
  return { ...input, cursorRelevanceScore: score };
}
