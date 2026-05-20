/**
 * GitHub adapter local types.
 *
 * The package implements two adapter "modes" against the same external
 * source (SPEC.md §5.2.2):
 *
 *   1. Profile refresh — periodic re-pull of known ambassador profiles.
 *      Input: a list of GitHub logins owned by ambassadors (in Phase 2 these
 *      come from `person_platform_identity` rows where `platform = 'github'`,
 *      but we model that source behind an interface so the adapter does not
 *      depend on the db package at this stage).
 *
 *   2. Repo search — daily search for repositories or READMEs that mention
 *      Cursor. Each match becomes an Artifact + Person + (optional)
 *      Communication.
 *
 * Both modes share the same {@link GithubClient} from `./client.ts`. Each
 * mode has its own raw envelope so the on-disk shape mirrors the SPEC.md
 * §3.5 raw-table pattern (one raw table per fetch shape).
 */

import type { GithubProfileResponse, GithubRepoResponse } from './client.js';

// ---------------------------------------------------------------------------
// Profile mode
// ---------------------------------------------------------------------------

/**
 * One ambassador's GitHub profile as captured at fetch time. This is the
 * shape that gets persisted into `raw_github_profile.raw_payload`.
 *
 * `login` doubles as the source idempotency key — re-fetching the same login
 * always overwrites the same raw row (after first insert) rather than
 * appending duplicates.
 */
export interface RawGithubProfile {
  /** Lower-cased GitHub login. UNIQUE in `raw_github_profile.login`. */
  login: string;
  /** Raw profile snapshot from `GET /users/:login`. */
  profile: GithubProfileResponse;
  /**
   * Top N most recently-pushed public repos for this user. The SPEC calls
   * for "top repos" as Person enrichment; we keep this on the same raw row
   * so a single login is captured atomically.
   */
  topRepos: GithubRepoResponse[];
  /** ISO-8601 wall-clock at which the fetch completed. */
  fetchedAt: string;
  /**
   * SHA-256 hex digest of the canonical payload. Used downstream to skip
   * normalization when a refresh produced no observable change.
   */
  payloadHash: string;
}

// ---------------------------------------------------------------------------
// Repo-search mode
// ---------------------------------------------------------------------------

/**
 * How "cursor" appears for one repository observed during a search pass.
 * Drives the relevance score in {@link RawGithubRepoMatch.cursorRelevanceScore}.
 */
export interface CursorRelevance {
  /** README text contained a (case-insensitive) "cursor" mention. */
  inReadme: boolean;
  /**
   * Repository metadata (`name`, `description`, or `topics`) mentioned
   * Cursor — i.e. the maintainer surfaced the dependency at the repo level.
   */
  inRepoMetadata: boolean;
  /**
   * `cursor` appears in the source code only — we know about it via
   * `search/code`, not via a `search/repositories` hit nor a README mention.
   */
  inCodeOnly: boolean;
  /**
   * 0..1. Higher = more confidently about Cursor. The relevance bands match
   * what SPEC.md §3.2.4 (Communication.cursor_relevance_score) expects.
   *
   *   in_readme:        0.90
   *   in_repo_metadata: 0.60
   *   in_code_only:     0.30
   */
  cursorRelevanceScore: number;
}

/**
 * One repository captured during a Cursor-related search pass.
 * Persisted into `raw_github_repo.raw_payload`.
 *
 * `repoNodeId` (the GitHub GraphQL global id) doubles as the unique source
 * identifier so a re-search of the same repo overwrites the same raw row.
 * `repoId` (REST numeric id) is also stable per repo and is what the public
 * SPEC table uses. We persist both because the SPEC's `UNIQUE` constraint on
 * GitHub repo ID maps cleanly to `repoId`.
 */
export interface RawGithubRepoMatch {
  /** REST numeric repository ID. UNIQUE in `raw_github_repo.repo_id`. */
  repoId: number;
  /** GraphQL global node id (stable across renames). */
  repoNodeId: string;
  /** Full repo metadata at observation time. */
  repo: GithubRepoResponse;
  /** README text decoded from base64. `null` if the repo has no README. */
  readme: string | null;
  /** Relevance buckets and score; see {@link CursorRelevance}. */
  relevance: CursorRelevance;
  /** ISO-8601 wall-clock at which the fetch completed. */
  fetchedAt: string;
  /** SHA-256 of the canonical payload. */
  payloadHash: string;
}

// ---------------------------------------------------------------------------
// Inputs (ambassador list, search query options)
// ---------------------------------------------------------------------------

/**
 * Where the profile adapter gets its list of known ambassador GitHub
 * logins.
 *
 * In Phase 2 the production implementation reads `person_platform_identity`
 * rows where `platform = 'github'`. To keep the adapter package free of a
 * direct dependency on `@atlas/db`, that implementation lives in the
 * workflow layer; the adapter just consumes an `AmbassadorSource`. Tests
 * inject {@link StaticAmbassadorSource}.
 */
export interface AmbassadorSource {
  /** Return the list of GitHub logins to refresh, lower-cased. */
  list(): Promise<string[]>;
}

/**
 * Trivial in-memory implementation. Used by the CLI (`--logins=foo,bar`) and
 * by tests.
 */
export class StaticAmbassadorSource implements AmbassadorSource {
  private readonly logins: readonly string[];
  constructor(logins: readonly string[]) {
    this.logins = [...new Set(logins.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  }
  async list(): Promise<string[]> {
    return [...this.logins];
  }
}

/**
 * Options for the repo-search adapter. Defaults match the SPEC.md §5.2.2
 * daily cadence: one search query against `search/repositories` plus an
 * optional `search/code` pass to pick up "cursor in code only" repos.
 */
export interface RepoSearchOptions {
  /**
   * Primary `search/repositories` query. Defaults to `"cursor in:name,description,topics"`.
   */
  repoQuery?: string;
  /**
   * Optional `search/code` query for the "code-only" relevance bucket.
   * Set to `null` to skip the code-search pass entirely.
   * Defaults to `'"@cursor/sdk" OR "cursor.composer"'` (loose canary terms
   * for repos using Cursor-specific identifiers in code).
   */
  codeQuery?: string | null;
  /** Max pages to fetch from `search/repositories`. Default 1 (per-day search returns the freshest 30). */
  maxRepoPages?: number;
  /** Max pages to fetch from `search/code`. Default 1. */
  maxCodePages?: number;
  /** Results per page (max 100). Default 30. */
  perPage?: number;
  /**
   * Sort order. Defaults to `'updated'` so a daily run picks up the most
   * recently-touched repos first.
   */
  sort?: 'stars' | 'updated';
}
