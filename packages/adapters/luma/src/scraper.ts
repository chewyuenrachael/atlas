/**
 * Luma scraper — playwright-driven page fetching plus pure HTML parsing.
 *
 * Two layers, separated so unit tests can exercise parsing against fixtures
 * without ever launching a headless browser:
 *
 *   1. **Page fetchers** (`scrapeCommunityPage`, `scrapeEventDetail`) launch
 *      Chromium via playwright, render the React-rendered page, and return
 *      the final HTML. Both honor a filesystem cache under `.cache/luma/`
 *      (gitignored) to avoid hammering Luma during development.
 *   2. **HTML parsers** (`parseCommunityPageHtml`, `parseEventDetailHtml`) are
 *      pure functions over the HTML string. They look for, in priority order:
 *      Next.js `__NEXT_DATA__` JSON, JSON-LD `application/ld+json` blocks,
 *      then Open Graph meta tags, then anchor hrefs and visible text.
 *
 * Failure modes (per task brief):
 *   - Network timeout: page fetchers throw `IngestionError`. The adapter base
 *     class wraps every fetch in `withRetry` (3 attempts by default).
 *   - HTML structure changes: parsers return null/empty fields rather than
 *     throwing. The adapter logs a warning and continues with what's available.
 *   - Event missing required fields: parsers fill optional fields with null
 *     and the normalizer is responsible for warning + producing a partial
 *     record. Events with no resolvable title or slug are dropped.
 *
 * SPEC.md §5.2.1 — Luma adapter source contract.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { IngestionError, logger } from '@atlas/core';
import type * as PlaywrightModule from 'playwright';
import type {
  CommunityEventListing,
  ScrapedEventDetail,
  ScrapedExternalLink,
  ScrapedExternalPlatform,
  ScrapedOrganizer,
} from './types.js';

const DEFAULT_BASE_URL = 'https://lu.ma';
const DEFAULT_COMMUNITY_SLUG = 'cursorcommunity';
const DEFAULT_TIMEOUT_MS = 30_000;
const NAVIGATION_WAIT_MS = 1_500;

const log = logger.child({ adapter: 'luma', component: 'scraper' });

// ---------------------------------------------------------------------------
// Public fetch helpers
// ---------------------------------------------------------------------------

export interface ScraperOptions {
  /** Override the Luma base URL. Defaults to `LUMA_BASE_URL` env or `https://lu.ma`. */
  baseUrl?: string;
  /** Override the community slug. Defaults to `LUMA_COMMUNITY_SLUG` env or `cursorcommunity`. */
  communitySlug?: string;
  /** Per-request timeout. Defaults to 30s. */
  timeoutMs?: number;
  /** When true, read/write `.cache/luma/<slug>.html`. Auto-enabled when ATLAS_ENV=development. */
  useCache?: boolean;
  /** Override the cache directory. Defaults to `<repo>/.cache/luma`. */
  cacheDir?: string;
  /**
   * Injection point for tests. If supplied, the scraper does not launch
   * playwright and instead calls `fetchHtml(url)` for every request.
   */
  htmlFetcher?: (url: string) => Promise<string>;
}

interface ResolvedScraperOptions {
  baseUrl: string;
  communitySlug: string;
  timeoutMs: number;
  useCache: boolean;
  cacheDir: string;
  htmlFetcher?: (url: string) => Promise<string>;
}

function resolveOptions(opts: ScraperOptions = {}): ResolvedScraperOptions {
  const baseUrl = (opts.baseUrl ?? process.env['LUMA_BASE_URL'] ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const communitySlug =
    opts.communitySlug ?? process.env['LUMA_COMMUNITY_SLUG'] ?? DEFAULT_COMMUNITY_SLUG;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const useCache = opts.useCache ?? (process.env['ATLAS_ENV'] ?? 'development') === 'development';
  const cacheDir = opts.cacheDir ?? path.resolve(process.cwd(), '.cache', 'luma');
  const resolved: ResolvedScraperOptions = {
    baseUrl,
    communitySlug,
    timeoutMs,
    useCache,
    cacheDir,
  };
  if (opts.htmlFetcher) resolved.htmlFetcher = opts.htmlFetcher;
  return resolved;
}

/**
 * Discover events listed on the configured community page.
 *
 * @example
 * ```ts
 * const listings = await scrapeCommunityPage();
 * console.log(`Found ${listings.length} events`);
 * ```
 */
export async function scrapeCommunityPage(
  opts: ScraperOptions = {},
): Promise<CommunityEventListing[]> {
  const resolved = resolveOptions(opts);
  const url = `${resolved.baseUrl}/${resolved.communitySlug}`;
  const html = await fetchHtmlWithCache(url, `community-${resolved.communitySlug}`, resolved);
  return parseCommunityPageHtml(html, resolved.baseUrl);
}

/**
 * Scrape a single event detail page.
 *
 * @example
 * ```ts
 * const detail = await scrapeEventDetail('https://lu.ma/cursor-sf-jun');
 * console.log(detail.title, detail.startsAt);
 * ```
 */
export async function scrapeEventDetail(
  url: string,
  opts: ScraperOptions = {},
): Promise<ScrapedEventDetail> {
  const resolved = resolveOptions(opts);
  const slug = extractSlugFromUrl(url) ?? hashSlug(url);
  const html = await fetchHtmlWithCache(url, `event-${slug}`, resolved);
  return parseEventDetailHtml(html, url);
}

// ---------------------------------------------------------------------------
// Caching + HTML fetch
// ---------------------------------------------------------------------------

async function fetchHtmlWithCache(
  url: string,
  cacheKey: string,
  resolved: ResolvedScraperOptions,
): Promise<string> {
  if (resolved.useCache) {
    const cached = await readCache(resolved.cacheDir, cacheKey);
    if (cached !== null) {
      log.debug({ url, cacheKey }, 'serving Luma HTML from cache');
      return cached;
    }
  }
  const html = resolved.htmlFetcher
    ? await resolved.htmlFetcher(url)
    : await fetchHtmlWithPlaywright(url, resolved.timeoutMs);
  if (resolved.useCache) {
    await writeCache(resolved.cacheDir, cacheKey, html);
  }
  return html;
}

async function readCache(cacheDir: string, key: string): Promise<string | null> {
  const file = path.join(cacheDir, `${key}.html`);
  try {
    return await fs.readFile(file, 'utf8');
  } catch (cause) {
    if (isFileNotFound(cause)) return null;
    log.warn({ err: cause, file }, 'cache read failed; falling through');
    return null;
  }
}

async function writeCache(cacheDir: string, key: string, html: string): Promise<void> {
  const file = path.join(cacheDir, `${key}.html`);
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(file, html, 'utf8');
  } catch (cause) {
    log.warn({ err: cause, file }, 'cache write failed; continuing');
  }
}

function isFileNotFound(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code: unknown }).code === 'ENOENT'
  );
}

/**
 * Launch a short-lived Chromium instance, render the URL, return the HTML.
 *
 * Playwright is imported dynamically so unit tests don't pull in the browser
 * binary loader. The browser launch is wrapped in a try/finally to guarantee
 * cleanup even on timeout.
 */
async function fetchHtmlWithPlaywright(url: string, timeoutMs: number): Promise<string> {
  // Dynamic import keeps tests fast and lets the package install without the
  // browser binary when scraping isn't needed (e.g. read-only CI jobs).
  const { chromium } = (await import('playwright').catch((cause) => {
    throw new IngestionError(
      'playwright is required for live Luma scraping; install with `pnpm exec playwright install chromium`',
      'INGESTION_FAILED',
      { url },
      cause,
    );
  })) as typeof PlaywrightModule;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
        'Version/17.0 Safari/605.1.15 atlas-luma-scraper/0.1',
      viewport: { width: 1280, height: 1024 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    } catch (cause) {
      // `networkidle` is brittle on Luma's chat-heavy pages; fall back to
      // `domcontentloaded` and a short settle wait. This is a deliberate
      // belt-and-suspenders so we never lose an event purely because of an
      // analytics socket that won't close.
      log.warn({ err: cause, url }, 'networkidle timed out; falling back to DOMContentLoaded');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForTimeout(NAVIGATION_WAIT_MS);
    }
    return await page.content();
  } finally {
    await browser.close().catch((cause: unknown) => {
      log.warn({ err: cause, url }, 'browser close failed');
    });
  }
}

// ---------------------------------------------------------------------------
// Pure HTML parsers
// ---------------------------------------------------------------------------

/**
 * Parse the community page HTML and return a list of event references.
 *
 * Pure function. Safe to call from tests with fixture HTML.
 *
 * @example
 * ```ts
 * const listings = parseCommunityPageHtml(htmlString, 'https://lu.ma');
 * ```
 */
export function parseCommunityPageHtml(
  html: string,
  baseUrl: string = DEFAULT_BASE_URL,
): CommunityEventListing[] {
  const seen = new Map<string, CommunityEventListing>();

  for (const event of extractEventsFromNextData(html)) {
    if (!event.slug || seen.has(event.slug)) continue;
    seen.set(event.slug, {
      slug: event.slug,
      url: event.url ?? `${baseUrl}/${event.slug}`,
      title: event.title ?? null,
      startsAtText: event.startsAtIso ?? null,
    });
  }

  for (const slug of extractEventSlugsFromAnchors(html, baseUrl)) {
    if (seen.has(slug)) continue;
    const title = extractTitleForSlug(html, slug);
    seen.set(slug, {
      slug,
      url: `${baseUrl}/${slug}`,
      title,
      startsAtText: null,
    });
  }

  return [...seen.values()];
}

/**
 * Parse a single event detail page into a structured snapshot.
 *
 * Returns a best-effort result; missing fields are null rather than throwing.
 * Callers that need at least a title + slug should branch on the result.
 *
 * @example
 * ```ts
 * const detail = parseEventDetailHtml(htmlString, 'https://lu.ma/cursor-sf-jun');
 * ```
 */
export function parseEventDetailHtml(html: string, url: string): ScrapedEventDetail {
  const slug = extractSlugFromUrl(url) ?? hashSlug(url);

  const jsonLd = collectJsonLdEvents(html);
  const ldEvent = jsonLd[0];

  const nextDataEvent = extractEventFromNextData(html, slug);

  const ogTitle = matchMeta(html, 'og:title');
  const ogDescription = matchMeta(html, 'og:description');
  const ogImage = matchMeta(html, 'og:image');

  const title = coerceText(ldEvent?.name) ?? coerceText(nextDataEvent?.title) ?? ogTitle ?? slug;

  const description =
    coerceText(ldEvent?.description) ?? coerceText(nextDataEvent?.description) ?? ogDescription;

  const startsAt = toIsoOrNull(ldEvent?.startDate) ?? nextDataEvent?.startsAtIso ?? null;
  const endsAt = toIsoOrNull(ldEvent?.endDate) ?? nextDataEvent?.endsAtIso ?? null;
  const timezone = nextDataEvent?.timezone ?? null;

  const location = extractLocation(ldEvent, nextDataEvent);
  const coverImageUrl = coerceText(ldEvent?.image) ?? nextDataEvent?.coverImageUrl ?? ogImage;
  const eventFormat = inferEventFormat(html, ldEvent, nextDataEvent);
  const registeredCount = nextDataEvent?.registeredCount ?? extractRegisteredCountFromHtml(html);

  const organizers = mergeOrganizers(
    extractOrganizersFromJsonLd(jsonLd),
    nextDataEvent?.organizers ?? [],
  );
  const eventLinks = extractExternalLinks(html, {
    excludeUrls: organizers.flatMap((o) => collectOrganizerUrls(o)),
  });

  return {
    slug,
    url,
    title: title.trim(),
    description: description ? description.trim() : null,
    startsAt,
    endsAt,
    timezone,
    venueName: location.venueName,
    venueAddress: location.venueAddress,
    venueCity: location.venueCity,
    venueCountry: location.venueCountry,
    eventFormat,
    registeredCount,
    coverImageUrl: coverImageUrl ?? null,
    organizers,
    eventLinks,
  };
}

// ---------------------------------------------------------------------------
// Internal — slug + URL utilities
// ---------------------------------------------------------------------------

const NAVIGATION_SLUGS = new Set([
  '',
  'discover',
  'login',
  'signup',
  'signin',
  'home',
  'create',
  'pricing',
  'about',
  'help',
  'terms',
  'privacy',
  'press',
  'manage',
  'settings',
  'cursorcommunity',
  'communities',
  'community',
  'calendar',
  'event',
  'events',
  'u',
  'p',
  'i',
  'cdn-cgi',
]);

function extractSlugFromUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    const first = segments[0];
    if (!first || NAVIGATION_SLUGS.has(first)) return null;
    return first;
  } catch {
    return null;
  }
}

function hashSlug(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function extractEventSlugsFromAnchors(html: string, baseUrl: string): string[] {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const slugs = new Set<string>();
  // Match href attribute values that look like event URLs:
  //   href="https://lu.ma/<slug>" or href="/<slug>"
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw, normalizedBase);
    } catch {
      continue;
    }
    if (!isLumaHost(url.host, normalizedBase)) continue;
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    if (segments.length !== 1) continue;
    const slug = segments[0];
    if (!slug || NAVIGATION_SLUGS.has(slug)) continue;
    if (!isPlausibleEventSlug(slug)) continue;
    slugs.add(slug);
  }
  return [...slugs];
}

function isLumaHost(host: string, baseUrl: string): boolean {
  const normalizedHost = host.toLowerCase();
  if (normalizedHost === 'lu.ma' || normalizedHost.endsWith('.lu.ma')) return true;
  try {
    const base = new URL(baseUrl);
    if (base.host.toLowerCase() === normalizedHost) return true;
  } catch {
    // ignore
  }
  return false;
}

function isPlausibleEventSlug(slug: string): boolean {
  // Luma slugs are URL-safe lowercase alphanumeric with optional hyphens.
  // Real-world examples: `9ifuc4yo`, `cursor-sf-jun`, `community-launch-2025`.
  return /^[a-z0-9][a-z0-9-]{2,79}$/.test(slug);
}

function extractTitleForSlug(html: string, slug: string): string | null {
  // Look for an anchor that points to this slug and lift any nearby text node.
  const escaped = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`<a[^>]+href\\s*=\\s*"[^"]*/${escaped}"[^>]*>([\\s\\S]*?)</a>`, 'i');
  const m = re.exec(html);
  if (!m || !m[1]) return null;
  const stripped = stripTags(m[1]).trim();
  return stripped.length > 0 ? stripped : null;
}

// ---------------------------------------------------------------------------
// Internal — JSON-LD extraction
// ---------------------------------------------------------------------------

interface JsonLdEvent {
  '@type'?: string | string[];
  name?: unknown;
  description?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  eventAttendanceMode?: unknown;
  image?: unknown;
  location?: unknown;
  organizer?: unknown;
  performer?: unknown;
}

function collectJsonLdEvents(html: string): JsonLdEvent[] {
  const blocks = matchAllJsonLdBlocks(html);
  const events: JsonLdEvent[] = [];
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    visitJsonLdNode(parsed, (node) => {
      if (isJsonLdEvent(node)) events.push(node);
    });
  }
  return events;
}

function matchAllJsonLdBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]*type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function visitJsonLdNode(value: unknown, visitor: (node: JsonLdEvent) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) visitJsonLdNode(v, visitor);
    return;
  }
  if (value && typeof value === 'object') {
    visitor(value as JsonLdEvent);
    // Common JSON-LD wrapper: `{"@graph": [...]}`
    const graph = (value as { '@graph'?: unknown })['@graph'];
    if (graph) visitJsonLdNode(graph, visitor);
  }
}

function isJsonLdEvent(node: JsonLdEvent): boolean {
  const t = node['@type'];
  if (!t) return false;
  if (typeof t === 'string') return /event/i.test(t);
  if (Array.isArray(t)) return t.some((v) => typeof v === 'string' && /event/i.test(v));
  return false;
}

function extractOrganizersFromJsonLd(events: JsonLdEvent[]): ScrapedOrganizer[] {
  const out: ScrapedOrganizer[] = [];
  for (const ev of events) {
    for (const node of toJsonLdPersons(ev.organizer)) {
      const name = coerceText(node.name);
      if (!name) continue;
      const profileUrl = coerceText(node.url);
      out.push(buildOrganizer(name, profileUrl, coerceText(node.image), null));
    }
  }
  return out;
}

function toJsonLdPersons(
  value: unknown,
): Array<{ name?: unknown; url?: unknown; image?: unknown }> {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => toJsonLdPersons(v));
  }
  if (typeof value === 'object') {
    return [value as { name?: unknown; url?: unknown; image?: unknown }];
  }
  if (typeof value === 'string') {
    return [{ name: value }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Internal — __NEXT_DATA__ extraction
// ---------------------------------------------------------------------------

interface NextDataEvent {
  slug: string;
  url?: string;
  title?: string;
  description?: string;
  startsAtIso?: string;
  endsAtIso?: string;
  timezone?: string;
  venueName?: string;
  venueAddress?: string;
  venueCity?: string;
  venueCountry?: string;
  coverImageUrl?: string;
  registeredCount?: number;
  isOnline?: boolean;
  organizers: ScrapedOrganizer[];
}

function readNextDataPayload(html: string): unknown {
  const re = /<script[^>]+id\s*=\s*"__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
  const m = re.exec(html);
  if (!m || !m[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch (cause) {
    log.warn({ err: cause }, 'failed to parse __NEXT_DATA__');
    return null;
  }
}

function extractEventsFromNextData(html: string): NextDataEvent[] {
  const data = readNextDataPayload(html);
  if (!data) return [];
  const events = new Map<string, NextDataEvent>();
  visitNextDataNode(data, (node) => {
    const ev = nodeToEvent(node);
    if (ev && !events.has(ev.slug)) events.set(ev.slug, ev);
  });
  return [...events.values()];
}

function extractEventFromNextData(html: string, slug: string): NextDataEvent | null {
  for (const ev of extractEventsFromNextData(html)) {
    if (ev.slug === slug) return ev;
  }
  // Fallback: the first event-shaped node found, since detail pages typically
  // embed only one.
  const all = extractEventsFromNextData(html);
  return all[0] ?? null;
}

function visitNextDataNode(value: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) visitNextDataNode(v, visitor);
    return;
  }
  if (value && typeof value === 'object') {
    visitor(value as Record<string, unknown>);
    for (const v of Object.values(value as Record<string, unknown>)) {
      visitNextDataNode(v, visitor);
    }
  }
}

function nodeToEvent(node: Record<string, unknown>): NextDataEvent | null {
  // Heuristic: a Luma event object has both a url-safe identifier (`url`,
  // `slug`, or `api_id`) and a start time (`start_at` or `startAt`).
  const slug = pickSlug(node);
  if (!slug) return null;
  const start = pickString(node, ['start_at', 'startAt', 'starts_at', 'startsAt', 'start_date']);
  if (!start) return null;
  const title = pickString(node, ['name', 'title']);
  const desc = pickString(node, ['description', 'short_description', 'descriptionText']);
  const ev: NextDataEvent = {
    slug,
    organizers: extractOrganizersFromNode(node),
  };
  const url = pickString(node, ['url', 'eventUrl']);
  if (url && /^https?:\/\//i.test(url)) ev.url = url;
  if (title) ev.title = title;
  if (desc) ev.description = desc;
  const startIso = toIsoOrNull(start);
  if (startIso) ev.startsAtIso = startIso;
  const endIso = toIsoOrNull(
    pickString(node, ['end_at', 'endAt', 'ends_at', 'endsAt', 'end_date']),
  );
  if (endIso) ev.endsAtIso = endIso;
  const timezone = pickString(node, ['timezone', 'tz']);
  if (timezone) ev.timezone = timezone;
  const venueName = pickString(node, ['venue_name', 'venueName', 'geo_address_name']);
  if (venueName) ev.venueName = venueName;
  const venueAddress = pickString(node, [
    'venue_address',
    'venueAddress',
    'geo_address_info',
    'geo_address',
  ]);
  if (venueAddress) ev.venueAddress = venueAddress;
  const venueCity = pickString(node, ['venue_city', 'venueCity', 'city', 'geo_city']);
  if (venueCity) ev.venueCity = venueCity;
  const venueCountry = pickString(node, [
    'venue_country',
    'venueCountry',
    'country',
    'geo_country',
  ]);
  if (venueCountry) ev.venueCountry = venueCountry;
  const coverImageUrl = pickString(node, ['cover_url', 'coverUrl', 'cover_image_url']);
  if (coverImageUrl) ev.coverImageUrl = coverImageUrl;
  const registered = pickNumber(node, [
    'registered_count',
    'registeredCount',
    'guest_count',
    'guestCount',
    'attendee_count',
  ]);
  if (registered !== null) ev.registeredCount = registered;
  const isOnline = pickBool(node, ['is_online', 'isOnline', 'is_virtual']);
  if (isOnline !== null) ev.isOnline = isOnline;
  return ev;
}

function pickSlug(node: Record<string, unknown>): string | null {
  const candidates = ['url', 'eventUrl', 'slug', 'event_slug', 'api_id', 'apiId'];
  for (const key of candidates) {
    const v = node[key];
    if (typeof v !== 'string' || v.length === 0) continue;
    // If it's a URL, extract the last path segment.
    if (v.startsWith('http')) {
      const extracted = extractSlugFromUrl(v);
      if (extracted) return extracted;
      continue;
    }
    if (isPlausibleEventSlug(v)) return v;
  }
  return null;
}

function pickString(node: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}

function pickNumber(node: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickBool(node: Record<string, unknown>, keys: string[]): boolean | null {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'boolean') return v;
  }
  return null;
}

function extractOrganizersFromNode(node: Record<string, unknown>): ScrapedOrganizer[] {
  const out: ScrapedOrganizer[] = [];
  const candidates: unknown[] = [];
  for (const key of ['hosts', 'host', 'organizers', 'organizer', 'cohosts', 'co_hosts']) {
    const v = node[key];
    if (v) candidates.push(v);
  }
  for (const c of candidates) {
    for (const person of toPersonLikeNodes(c)) {
      const name = pickString(person, ['name', 'display_name', 'displayName']);
      if (!name) continue;
      const url = pickString(person, ['url', 'profile_url', 'profileUrl']);
      const avatar = pickString(person, ['avatar_url', 'avatarUrl', 'photo_url', 'image']);
      const externalLinks: ScrapedExternalLink[] = [];
      for (const key of ['twitter_url', 'twitter', 'x_url']) {
        const v = pickString(person, [key]);
        if (v) externalLinks.push(buildExternalLink('twitter', v));
      }
      for (const key of ['github_url', 'github']) {
        const v = pickString(person, [key]);
        if (v) externalLinks.push(buildExternalLink('github', v));
      }
      for (const key of ['linkedin_url', 'linkedin']) {
        const v = pickString(person, [key]);
        if (v) externalLinks.push(buildExternalLink('linkedin', v));
      }
      for (const key of ['website', 'website_url']) {
        const v = pickString(person, [key]);
        if (v) externalLinks.push(buildExternalLink('website', v));
      }
      out.push(buildOrganizer(name, url, avatar, externalLinks));
    }
  }
  return out;
}

function toPersonLikeNodes(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((v) => toPersonLikeNodes(v));
  if (typeof value === 'object') return [value as Record<string, unknown>];
  if (typeof value === 'string') return [{ name: value }];
  return [];
}

// ---------------------------------------------------------------------------
// Internal — meta + visible text
// ---------------------------------------------------------------------------

function matchMeta(html: string, property: string): string | null {
  // Match either `<meta property="og:title" content="...">` or `<meta name="...">`.
  const escapedProp = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns: RegExp[] = [
    new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*"${escapedProp}"[^>]*content\\s*=\\s*"([^"]*)"`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content\\s*=\\s*"([^"]*)"[^>]*(?:property|name)\\s*=\\s*"${escapedProp}"`,
      'i',
    ),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) return decodeHtmlEntities(m[1]);
  }
  return null;
}

function extractRegisteredCountFromHtml(html: string): number | null {
  // Match visible patterns like "1,234 attending" / "523 going" / "42 registered".
  const re = /([\d,]+)\s*(attending|going|registered|guests|attendees)/i;
  const m = re.exec(html);
  if (!m || !m[1]) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function extractLocation(
  ldEvent: JsonLdEvent | undefined,
  nextDataEvent: NextDataEvent | null,
): {
  venueName: string | null;
  venueAddress: string | null;
  venueCity: string | null;
  venueCountry: string | null;
} {
  const ldLocation = toLocationNode(ldEvent?.location);
  const venueName = coerceText(ldLocation?.name) ?? nextDataEvent?.venueName ?? null;
  const venueAddressNode = ldLocation?.address;
  let venueAddress: string | null = null;
  let venueCity: string | null = null;
  let venueCountry: string | null = null;
  if (typeof venueAddressNode === 'string') {
    venueAddress = venueAddressNode;
  } else if (venueAddressNode && typeof venueAddressNode === 'object') {
    const addr = venueAddressNode as Record<string, unknown>;
    venueAddress = coerceText(addr['streetAddress']) ?? coerceText(addr['name']) ?? null;
    venueCity = coerceText(addr['addressLocality']) ?? null;
    venueCountry = coerceText(addr['addressCountry']) ?? null;
  }
  return {
    venueName,
    venueAddress: venueAddress ?? nextDataEvent?.venueAddress ?? null,
    venueCity: venueCity ?? nextDataEvent?.venueCity ?? null,
    venueCountry: venueCountry ?? nextDataEvent?.venueCountry ?? null,
  };
}

function toLocationNode(value: unknown): { name?: unknown; address?: unknown } | null {
  if (!value) return null;
  if (Array.isArray(value)) return toLocationNode(value[0]);
  if (typeof value === 'object') return value as { name?: unknown; address?: unknown };
  if (typeof value === 'string') return { name: value };
  return null;
}

function inferEventFormat(
  html: string,
  ldEvent: JsonLdEvent | undefined,
  nextDataEvent: NextDataEvent | null,
): 'in_person' | 'virtual' | 'hybrid' | null {
  const mode = coerceText(ldEvent?.eventAttendanceMode);
  if (mode) {
    if (/online/i.test(mode)) return 'virtual';
    if (/offline|in.?person/i.test(mode)) return 'in_person';
    if (/mixed|hybrid/i.test(mode)) return 'hybrid';
  }
  if (nextDataEvent?.isOnline === true) return 'virtual';
  if (nextDataEvent?.isOnline === false) return 'in_person';
  // Last resort: presence of zoom/meet/youtube link suggests virtual.
  if (/zoom\.us\/|meet\.google\.com|youtube\.com\/live/i.test(html)) return 'virtual';
  return null;
}

function extractExternalLinks(
  html: string,
  opts: { excludeUrls: string[] },
): ScrapedExternalLink[] {
  const excluded = new Set(opts.excludeUrls);
  const found = new Map<string, ScrapedExternalLink>();
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (!raw || excluded.has(raw)) continue;
    const link = classifyExternalLink(raw);
    if (!link) continue;
    if (!found.has(link.url)) found.set(link.url, link);
  }
  return [...found.values()];
}

function classifyExternalLink(rawUrl: string): ScrapedExternalLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  const path = url.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  if (host === 'twitter.com' || host === 'x.com' || host.endsWith('.twitter.com')) {
    return buildExternalLink('twitter', url.toString(), path.replace(/^@/, '') || null);
  }
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return buildExternalLink('github', url.toString(), path || null);
  }
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    const handle = segments[0] === 'in' && segments[1] ? segments[1] : null;
    return buildExternalLink('linkedin', url.toString(), handle);
  }
  return null;
}

function buildExternalLink(
  platform: ScrapedExternalPlatform,
  url: string,
  handle: string | null = null,
): ScrapedExternalLink {
  if (handle === null) {
    return { platform, url, handle: deriveHandleFromUrl(platform, url) };
  }
  return { platform, url, handle };
}

function deriveHandleFromUrl(platform: ScrapedExternalPlatform, raw: string): string | null {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    if (platform === 'linkedin' && segments[0] === 'in' && segments[1]) return segments[1];
    return segments[0]?.replace(/^@/, '') ?? null;
  } catch {
    return null;
  }
}

function buildOrganizer(
  name: string,
  profileUrl: string | null,
  avatarUrl: string | null,
  externalLinks: ScrapedExternalLink[] | null,
): ScrapedOrganizer {
  const lumaHandle = deriveLumaHandle(name, profileUrl);
  return {
    name: name.trim(),
    lumaHandle,
    lumaProfileUrl: profileUrl,
    avatarUrl,
    externalLinks: externalLinks ?? [],
  };
}

function deriveLumaHandle(name: string, profileUrl: string | null): string {
  if (profileUrl) {
    try {
      const url = new URL(profileUrl);
      const segments = url.pathname.split('/').filter((s) => s.length > 0);
      // Luma profile URLs come in three shapes:
      //   `/<handle>`            (calendar pages, e.g. lu.ma/cursorcommunity)
      //   `/u/<handle>`          (legacy short profile URLs)
      //   `/user/<opaque_id>`    (current canonical profile URLs)
      // For the first two the handle is human-readable; for the third the
      // path prefix is literally `user` and the meaningful identifier is the
      // opaque id underneath. Using `segments[0]` for `/user/...` would
      // collapse every distinct Luma profile to the same handle.
      const firstSeg = segments[0];
      const isProfilePrefix = firstSeg === 'u' || firstSeg === 'user';
      const handle = isProfilePrefix && segments[1] ? segments[1] : firstSeg;
      if (handle) return handle.toLowerCase();
    } catch {
      // ignore
    }
  }
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function mergeOrganizers(a: ScrapedOrganizer[], b: ScrapedOrganizer[]): ScrapedOrganizer[] {
  const byKey = new Map<string, ScrapedOrganizer>();
  for (const o of [...a, ...b]) {
    const key = o.lumaProfileUrl?.toLowerCase() ?? o.lumaHandle.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, o);
      continue;
    }
    const linksByUrl = new Map<string, ScrapedExternalLink>();
    for (const l of [...existing.externalLinks, ...o.externalLinks]) {
      linksByUrl.set(l.url, l);
    }
    byKey.set(key, {
      name: existing.name || o.name,
      lumaHandle: existing.lumaHandle || o.lumaHandle,
      lumaProfileUrl: existing.lumaProfileUrl ?? o.lumaProfileUrl,
      avatarUrl: existing.avatarUrl ?? o.avatarUrl,
      externalLinks: [...linksByUrl.values()],
    });
  }
  return [...byKey.values()];
}

function collectOrganizerUrls(o: ScrapedOrganizer): string[] {
  const out: string[] = [];
  if (o.lumaProfileUrl) out.push(o.lumaProfileUrl);
  for (const l of o.externalLinks) out.push(l.url);
  return out;
}

// ---------------------------------------------------------------------------
// Internal — small helpers
// ---------------------------------------------------------------------------

function coerceText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (value && typeof value === 'object') {
    const candidate = value as { '@value'?: unknown; name?: unknown; text?: unknown };
    return (
      coerceText(candidate['@value']) ??
      coerceText(candidate.name) ??
      coerceText(candidate.text) ??
      null
    );
  }
  return null;
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#?[a-z0-9]+);/gi, (match, code) => {
    if (typeof code !== 'string') return match;
    const lower = code.toLowerCase();
    if (lower in HTML_ENTITY_MAP) return HTML_ENTITY_MAP[lower] as string;
    if (lower.startsWith('#x')) {
      const cp = parseInt(lower.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    if (lower.startsWith('#')) {
      const cp = parseInt(lower.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    return match;
  });
}
