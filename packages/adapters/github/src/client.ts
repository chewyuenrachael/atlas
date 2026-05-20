/**
 * GitHub client — a thin Octokit wrapper used by both the profile and
 * repo-search adapters.
 *
 * SPEC.md §5.2.2 lists the contract: REST (Octokit `@octokit/rest`) plus
 * GraphQL where batching matters. Phase 2 sticks to REST endpoints; GraphQL
 * is a Phase 3+ optimization that can sit behind the same {@link GithubClient}
 * facade without touching the adapters above it.
 *
 * Responsibilities:
 *   - Read `GITHUB_TOKEN` from the environment exactly once.
 *   - Surface a clean `ConfigError` when the token is missing rather than
 *     letting `@octokit/rest` produce a confusing 401 later.
 *   - Expose narrow domain methods (`getProfile`, `listUserRepos`,
 *     `searchRepositories`, `getReadme`, `searchCodeRepos`) so adapters never
 *     reach into the raw Octokit surface.
 *   - Track the most recent `x-ratelimit-*` response headers so the CLI / Inngest
 *     workflow can report rate-limit observations.
 *
 * @example
 * ```ts
 * import { createGithubClient, isMissingTokenError } from './client.js';
 *
 * const result = createGithubClient();
 * if (!result.ok) {
 *   if (isMissingTokenError(result.error)) {
 *     console.error('GITHUB_TOKEN not set; exiting');
 *     process.exit(0);
 *   }
 *   throw result.error;
 * }
 * const profile = await result.value.getProfile('alicechen');
 * ```
 */
import { Octokit } from '@octokit/rest';
import {
  ConfigError,
  ExternalApiError,
  IngestionError,
  err,
  ok,
  type AtlasError,
  type Result,
} from '@atlas/core';

/**
 * The shape we keep regardless of which Octokit major version is installed.
 * Octokit's TypeScript surface is generated and large; the adapters only care
 * about a handful of fields, so we project responses through these interfaces.
 */
export interface GithubProfileResponse {
  login: string;
  id: number;
  name: string | null;
  bio: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  twitter_username: string | null;
  avatar_url: string;
  html_url: string;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
  updated_at: string;
}

export interface GithubRepoResponse {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: {
    login: string;
    id: number;
    type: string;
    html_url: string;
    avatar_url: string;
  };
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
  topics: string[];
  default_branch: string;
  pushed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface RateLimitObservation {
  /** Calls remaining in the current window. */
  remaining: number | null;
  /** Window cap (5000 for an authenticated PAT). */
  limit: number | null;
  /** Unix epoch seconds when the window resets. */
  resetEpoch: number | null;
  /** Number of authenticated API calls made through this client so far. */
  calls: number;
}

export interface CreateGithubClientOptions {
  /** Override the env var read. Used by tests that don't want to touch process.env. */
  token?: string;
  /** Inject an Octokit-compatible instance. Tests use this; production never does. */
  octokit?: GithubOctokitLike;
  /** Override the user agent string. */
  userAgent?: string;
}

/**
 * The minimal Octokit surface area the wrapper depends on. Declared as a
 * structural interface so tests can pass a hand-rolled stub without pulling
 * the full Octokit type graph in.
 *
 * The signatures match the request shapes documented at
 * https://docs.github.com/rest as of late 2024; if Octokit's typings drift,
 * the wrapper is the single place to adapt.
 */
export interface GithubOctokitLike {
  request: <T = unknown>(
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{
    status: number;
    headers: Record<string, string | number | undefined>;
    data: T;
  }>;
}

/** Internal: read GITHUB_TOKEN with type narrowing under noUncheckedIndexedAccess. */
function readToken(): string | undefined {
  const raw = process.env['GITHUB_TOKEN'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The sentinel error code we use when GITHUB_TOKEN is missing. The CLI
 * checks for this code specifically so it can exit 0 (clean exit) rather
 * than treating it as a runtime crash.
 */
export const GITHUB_MISSING_TOKEN_CODE = 'INVALID_CONFIG' as const;

/**
 * Type-guard for callers that want to detect the specific "no token" case
 * without string-matching error messages.
 */
export function isMissingTokenError(error: AtlasError): boolean {
  return (
    error instanceof ConfigError &&
    error.code === GITHUB_MISSING_TOKEN_CODE &&
    error.context['env_var'] === 'GITHUB_TOKEN'
  );
}

/**
 * Construct a {@link GithubClient}. Returns a `Result` so callers can choose
 * to exit cleanly when the token is missing (CLI / workflow) versus surface
 * an error (production code paths that should hard-fail).
 */
export function createGithubClient(
  options: CreateGithubClientOptions = {},
): Result<GithubClient, AtlasError> {
  const userAgent = options.userAgent ?? 'atlas-github-adapter/0.1.0';
  if (options.octokit) {
    return ok(new GithubClient(options.octokit, '<injected>'));
  }
  const token = options.token ?? readToken();
  if (!token) {
    return err(
      new ConfigError(
        'GITHUB_TOKEN is not set; cannot authenticate against the GitHub API',
        GITHUB_MISSING_TOKEN_CODE,
        { env_var: 'GITHUB_TOKEN' },
      ),
    );
  }
  const octokit = new Octokit({ auth: token, userAgent });
  return ok(new GithubClient(octokit, token));
}

/**
 * Domain-facing GitHub client. Adapters depend on this interface, not on
 * `@octokit/rest` directly, so we can swap to GraphQL or a different HTTP
 * client without touching adapter code.
 */
export class GithubClient {
  private readonly octokit: GithubOctokitLike;
  private readonly tokenFingerprint: string;
  private rateLimit: RateLimitObservation = {
    remaining: null,
    limit: null,
    resetEpoch: null,
    calls: 0,
  };

  constructor(octokit: GithubOctokitLike, token: string) {
    this.octokit = octokit;
    this.tokenFingerprint = fingerprintToken(token);
  }

  /** Read the most recently observed rate-limit headers. */
  getRateLimit(): RateLimitObservation {
    return { ...this.rateLimit };
  }

  /** Identifying short hash of the token, safe to log. Never logs the token itself. */
  getTokenFingerprint(): string {
    return this.tokenFingerprint;
  }

  /** GET /users/:login — public profile. */
  async getProfile(login: string): Promise<GithubProfileResponse> {
    return this.call<GithubProfileResponse>('GET /users/{username}', { username: login });
  }

  /**
   * GET /users/:login/repos — top repos for a user, sorted by recent push.
   * `perPage` defaults to 10 (the "top repos" the SPEC calls out).
   */
  async listUserRepos(login: string, perPage = 10): Promise<GithubRepoResponse[]> {
    const data = await this.call<GithubRepoResponse[]>('GET /users/{username}/repos', {
      username: login,
      sort: 'pushed',
      direction: 'desc',
      per_page: perPage,
      type: 'owner',
    });
    return Array.isArray(data) ? data : [];
  }

  /**
   * GET /search/repositories — repository-level search. Use for finding
   * repos with "cursor" in name / description / topics.
   *
   * `page` is 1-indexed. GitHub caps total search results at 1000 across
   * pages, which is fine for our purposes (we re-run daily).
   */
  async searchRepositories(
    query: string,
    options: { perPage?: number; page?: number; sort?: 'stars' | 'updated' } = {},
  ): Promise<{ totalCount: number; items: GithubRepoResponse[] }> {
    const perPage = options.perPage ?? 30;
    const page = options.page ?? 1;
    const data = await this.call<{ total_count: number; items: GithubRepoResponse[] }>(
      'GET /search/repositories',
      {
        q: query,
        per_page: perPage,
        page,
        ...(options.sort ? { sort: options.sort, order: 'desc' } : {}),
      },
    );
    return { totalCount: data?.total_count ?? 0, items: data?.items ?? [] };
  }

  /**
   * GET /search/code — code-level search. Use for the "cursor in code only"
   * relevance bucket. Returns the repos that contain matching code without
   * the metadata also matching.
   *
   * NOTE: GitHub requires a `q` qualifier (e.g. `cursor in:file language:js`)
   * for code search. The caller is responsible for shaping the query.
   */
  async searchCodeRepos(
    query: string,
    options: { perPage?: number; page?: number } = {},
  ): Promise<{ totalCount: number; repoFullNames: string[] }> {
    const perPage = options.perPage ?? 30;
    const page = options.page ?? 1;
    interface CodeHit {
      repository: { full_name: string };
    }
    const data = await this.call<{ total_count: number; items: CodeHit[] }>('GET /search/code', {
      q: query,
      per_page: perPage,
      page,
    });
    const unique = new Set<string>();
    for (const item of data?.items ?? []) unique.add(item.repository.full_name);
    return { totalCount: data?.total_count ?? 0, repoFullNames: [...unique] };
  }

  /**
   * GET /repos/:owner/:repo/readme — raw README text, decoded from base64.
   * Returns `null` when the repo has no README (404).
   */
  async getReadme(owner: string, repo: string): Promise<string | null> {
    try {
      interface ReadmeResponse {
        content: string;
        encoding: 'base64' | string;
        size: number;
        name: string;
      }
      const data = await this.call<ReadmeResponse>('GET /repos/{owner}/{repo}/readme', {
        owner,
        repo,
      });
      if (!data) return null;
      if (data.encoding === 'base64') {
        return Buffer.from(data.content, 'base64').toString('utf8');
      }
      return data.content;
    } catch (cause) {
      if (isHttpStatus(cause, 404)) return null;
      throw cause;
    }
  }

  /** Issue one Octokit request, with rate-limit and error normalization. */
  private async call<T>(route: string, parameters: Record<string, unknown>): Promise<T> {
    let response;
    try {
      response = await this.octokit.request<T>(route, parameters);
    } catch (cause) {
      throw normalizeOctokitError(cause, route);
    }
    this.recordRateLimit(response.headers);
    this.rateLimit.calls += 1;
    return response.data;
  }

  private recordRateLimit(headers: Record<string, string | number | undefined>): void {
    const remaining = parseIntHeader(headers['x-ratelimit-remaining']);
    const limit = parseIntHeader(headers['x-ratelimit-limit']);
    const reset = parseIntHeader(headers['x-ratelimit-reset']);
    if (remaining !== null) this.rateLimit.remaining = remaining;
    if (limit !== null) this.rateLimit.limit = limit;
    if (reset !== null) this.rateLimit.resetEpoch = reset;
  }
}

function parseIntHeader(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function fingerprintToken(token: string): string {
  // Last 4 chars are enough to recognize "is this the same PAT" without
  // exposing the secret. Pad if the token is unexpectedly short.
  const tail = token.length >= 4 ? token.slice(-4) : token;
  return `…${tail}`;
}

function isHttpStatus(cause: unknown, status: number): boolean {
  if (cause && typeof cause === 'object' && 'status' in cause) {
    return (cause as { status: unknown }).status === status;
  }
  return false;
}

/**
 * Translate an Octokit `RequestError` into the appropriate AtlasError subclass
 * so adapter retry policies can branch on the code consistently.
 */
function normalizeOctokitError(cause: unknown, route: string): AtlasError {
  const status =
    cause && typeof cause === 'object' && 'status' in cause
      ? Number((cause as { status: unknown }).status)
      : null;
  const message = cause instanceof Error ? cause.message : String(cause);

  if (status === 401 || status === 403) {
    // 403 from GitHub is overloaded between "auth bad" and "rate limited";
    // disambiguate via header when possible.
    const headers =
      cause && typeof cause === 'object' && 'response' in cause
        ? (cause as { response?: { headers?: Record<string, string | number | undefined> } })
            .response?.headers
        : undefined;
    const remaining = parseIntHeader(headers?.['x-ratelimit-remaining']);
    if (status === 403 && remaining === 0) {
      return new IngestionError(
        `github rate limit hit on ${route}`,
        'INGESTION_RATE_LIMITED',
        { route, status, remaining },
        cause,
      );
    }
    return new IngestionError(
      `github auth failed on ${route}`,
      'INGESTION_AUTH_FAILED',
      { route, status },
      cause,
    );
  }
  if (status === 404) {
    return new IngestionError(
      `github resource not found on ${route}`,
      'INGESTION_NOT_FOUND',
      { route, status },
      cause,
    );
  }
  return new ExternalApiError(
    `github API error on ${route}: ${message}`,
    'EXTERNAL_API_ERROR',
    {
      route,
      status,
    },
    cause,
  );
}
