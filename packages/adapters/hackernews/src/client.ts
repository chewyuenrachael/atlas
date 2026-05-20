/**
 * Algolia Hacker News Search API client.
 *
 * The Algolia HN API is public, unauthenticated, and CORS-friendly. We use
 * the `/api/v1/search_by_date` endpoint sorted by `created_at_i` descending
 * so that incremental polls walk forward through the firehose deterministically.
 *
 * No new runtime dependencies — Node 20+ ships `globalThis.fetch` natively.
 *
 * @example
 * ```ts
 * const client = new AlgoliaHackerNewsClient();
 * const page = await client.search({ query: 'cursor', page: 0 });
 * console.log(`got ${page.hits.length} hits across ${page.nbPages} pages`);
 * ```
 *
 * See SPEC.md §5.2.6 and the public Algolia docs:
 * https://hn.algolia.com/api
 */
import { ExternalApiError } from '@atlas/core';
import type { HackerNewsAlgoliaResponse } from './types.js';

/** Default origin for the Algolia HN search API. Overridable for tests. */
export const ALGOLIA_HN_BASE_URL = 'https://hn.algolia.com';

/** Default search query for the Cursor Atlas: everything mentioning "cursor". */
export const DEFAULT_HN_QUERY = 'cursor';

/** Algolia caps `hitsPerPage` at 1000 but the practical sweet spot is ~20. */
export const DEFAULT_HITS_PER_PAGE = 20;

/** Algolia search tag combinator restricting results to stories + comments. */
export const DEFAULT_HN_TAGS = '(story,comment)';

/**
 * Public configuration knobs.
 *
 * All fields are optional — the adapter falls back to environment variables
 * (`HACKERNEWS_BASE_URL`, `HACKERNEWS_QUERY`) and then to the defaults above.
 */
export interface AlgoliaHackerNewsClientOptions {
  /** Override the Algolia origin (used by tests with mock servers). */
  baseUrl?: string;
  /** Override the search query (default: "cursor"). */
  query?: string;
  /** Override the tag combinator (default: `(story,comment)`). */
  tags?: string;
  /** Override `hitsPerPage` (default: 20, max 1000). */
  hitsPerPage?: number;
  /**
   * Inject an HTTP transport for tests. Defaults to `globalThis.fetch`. The
   * shape matches the WHATWG fetch standard so production code can use the
   * built-in fetch and tests can pass a stub.
   */
  fetchImpl?: typeof fetch;
}

/** Parameters for a single page request. */
export interface SearchParams {
  /** Zero-indexed page number. Algolia rejects pages beyond `nbPages - 1`. */
  page: number;
  /**
   * Optional unix-second cutoff. When set, only items with
   * `created_at_i > sinceUnix` are returned (Algolia `numericFilters`).
   * Used for incremental polls.
   */
  sinceUnix?: number;
  /** Override the default query for this request only. */
  query?: string;
}

/**
 * Thin wrapper around the Algolia HN Search API. Stateless — multiple
 * adapters can share the same client without coordination.
 */
export class AlgoliaHackerNewsClient {
  protected readonly baseUrl: string;
  protected readonly query: string;
  protected readonly tags: string;
  protected readonly hitsPerPage: number;
  protected readonly fetchImpl: typeof fetch;

  constructor(options: AlgoliaHackerNewsClientOptions = {}) {
    this.baseUrl =
      options.baseUrl ?? process.env['HACKERNEWS_BASE_URL'] ?? ALGOLIA_HN_BASE_URL;
    this.query = options.query ?? process.env['HACKERNEWS_QUERY'] ?? DEFAULT_HN_QUERY;
    this.tags = options.tags ?? DEFAULT_HN_TAGS;
    this.hitsPerPage = options.hitsPerPage ?? DEFAULT_HITS_PER_PAGE;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Currently-configured query string. Surfaced for logging. */
  get configuredQuery(): string {
    return this.query;
  }

  /** Currently-configured origin. Surfaced for logging. */
  get configuredBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Fetch one page of search results. Returns the parsed JSON envelope —
   * callers walk pagination themselves so each request stays inside the
   * adapter's rate-limit accounting.
   *
   * @throws {ExternalApiError} on non-2xx HTTP responses or malformed JSON.
   */
  async search(params: SearchParams): Promise<HackerNewsAlgoliaResponse> {
    const url = this.buildSearchUrl(params);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'atlas-hackernews-adapter/0.1' },
      });
    } catch (cause) {
      throw new ExternalApiError(
        'algolia hn search request failed',
        'NETWORK_ERROR',
        { url },
        cause,
      );
    }
    if (!response.ok) {
      const body = await safeReadBody(response);
      throw new ExternalApiError(
        `algolia hn search returned ${String(response.status)}`,
        'EXTERNAL_API_ERROR',
        { url, status: response.status, body },
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new ExternalApiError(
        'algolia hn search returned invalid json',
        'EXTERNAL_API_ERROR',
        { url },
        cause,
      );
    }
    return assertAlgoliaResponse(json, url);
  }

  /**
   * Build the request URL. Public so tests can assert the encoding without
   * stubbing fetch.
   */
  buildSearchUrl(params: SearchParams): string {
    const url = new URL('/api/v1/search_by_date', this.baseUrl);
    url.searchParams.set('query', params.query ?? this.query);
    url.searchParams.set('tags', this.tags);
    url.searchParams.set('hitsPerPage', String(this.hitsPerPage));
    url.searchParams.set('page', String(params.page));
    if (params.sinceUnix !== undefined && Number.isFinite(params.sinceUnix)) {
      url.searchParams.set('numericFilters', `created_at_i>${String(params.sinceUnix)}`);
    }
    return url.toString();
  }
}

/**
 * Defensively narrow an arbitrary JSON value into the typed envelope. Algolia
 * returns extra keys (`_highlightResult`, `processingTimeMS`, …) — we keep
 * them on the hit, just don't declare them in our type.
 */
function assertAlgoliaResponse(value: unknown, url: string): HackerNewsAlgoliaResponse {
  if (!value || typeof value !== 'object') {
    throw new ExternalApiError(
      'algolia hn search returned non-object payload',
      'EXTERNAL_API_ERROR',
      { url, value_type: typeof value },
    );
  }
  const obj = value as Record<string, unknown>;
  const hits = obj['hits'];
  const nbPages = obj['nbPages'];
  const nbHits = obj['nbHits'];
  const page = obj['page'];
  const hitsPerPage = obj['hitsPerPage'];
  if (!Array.isArray(hits)) {
    throw new ExternalApiError(
      'algolia hn search response missing hits array',
      'EXTERNAL_API_ERROR',
      { url },
    );
  }
  // We don't reject if numeric fields are missing — Algolia very rarely omits
  // them, and being defensive here lets the adapter degrade rather than crash.
  return {
    hits: hits as HackerNewsAlgoliaResponse['hits'],
    page: typeof page === 'number' ? page : 0,
    nbPages: typeof nbPages === 'number' ? nbPages : 1,
    nbHits: typeof nbHits === 'number' ? nbHits : hits.length,
    hitsPerPage: typeof hitsPerPage === 'number' ? hitsPerPage : hits.length,
  };
}

async function safeReadBody(response: Response): Promise<string | null> {
  try {
    return (await response.text()).slice(0, 512);
  } catch {
    return null;
  }
}
