/**
 * Luma adapter local types.
 *
 * `RawLumaEvent` is the durable on-disk shape stored in `raw_luma_event.raw_payload`.
 * It is the lossless capture of one event as observed at scrape time. Anything
 * derived (Person records, attendance edges, signals) is computed downstream
 * from this record — see `normalizer.ts`.
 *
 * Luma does not expose a comprehensive public API. We rely on:
 *   1. Public page scraping of `lu.ma/<community-slug>` for event discovery.
 *   2. Per-event page scraping of `lu.ma/<event-slug>` for detail.
 *
 * Attendee data is intentionally NOT captured here. See SPEC.md §5.2.1 and the
 * adapter README — attendee fetch requires authenticated Luma access and is
 * flagged as a Phase 2+ task.
 */

/** A single event listing as observed on the community page. */
export interface CommunityEventListing {
  /** Stable per-event identifier (Luma URL slug). Example: `cursorcommunity-sf-jun`. */
  slug: string;
  /** Canonical event URL on lu.ma. */
  url: string;
  /** Title text as it appears on the community page, if available. */
  title: string | null;
  /** Start time text or ISO string as it appears on the community page, if available. */
  startsAtText: string | null;
}

/** One organizer parsed from an event detail page. */
export interface ScrapedOrganizer {
  /** Display name as shown on Luma. */
  name: string;
  /**
   * URL-safe Luma handle for the organizer. Lifted from the organizer's Luma
   * profile URL when present (`lu.ma/u/<handle>`), otherwise a stable slug
   * derived from the display name.
   */
  lumaHandle: string;
  /** Luma profile URL, if linked. */
  lumaProfileUrl: string | null;
  /** Optional avatar URL. */
  avatarUrl: string | null;
  /**
   * Extra platform identities observed on the organizer's profile or under
   * their name on the event page (e.g. Twitter/X, GitHub, LinkedIn). Each is a
   * `(platform, url-or-handle)` pair that downstream identity resolution can
   * link back to the same Person.
   */
  externalLinks: ScrapedExternalLink[];
}

export type ScrapedExternalPlatform = 'twitter' | 'github' | 'linkedin' | 'website';

/** A non-Luma link associated with an organizer (or the event itself). */
export interface ScrapedExternalLink {
  platform: ScrapedExternalPlatform;
  /** Raw URL exactly as seen in the HTML. */
  url: string;
  /** Best-effort handle parsed from the URL (e.g. `@alicebuilds` -> `alicebuilds`). */
  handle: string | null;
}

/** The detail snapshot scraped from a single event page. */
export interface ScrapedEventDetail {
  /** Luma event slug (matches the URL path). */
  slug: string;
  /** Canonical event URL. */
  url: string;
  title: string;
  description: string | null;
  /** ISO-8601 start timestamp, UTC. */
  startsAt: string | null;
  /** ISO-8601 end timestamp, UTC. */
  endsAt: string | null;
  /** IANA timezone string if the page exposes one (e.g. `America/Los_Angeles`). */
  timezone: string | null;
  /** Free-text venue name (e.g. "Cursor HQ"). */
  venueName: string | null;
  /** Free-text venue address. */
  venueAddress: string | null;
  venueCity: string | null;
  venueCountry: string | null;
  /**
   * `in_person`, `virtual`, or `hybrid` if discernible from the page (presence
   * of a Zoom URL, "Online" marker, etc). Null when ambiguous.
   */
  eventFormat: 'in_person' | 'virtual' | 'hybrid' | null;
  /** Visible registration count, when shown. Luma often hides this. */
  registeredCount: number | null;
  /** Cover image URL, if any. */
  coverImageUrl: string | null;
  organizers: ScrapedOrganizer[];
  /** Non-organizer external links found on the page (sponsor, partner sites). */
  eventLinks: ScrapedExternalLink[];
}

/**
 * The raw record persisted into `raw_luma_event.raw_payload`. This is the
 * source-of-truth snapshot — every downstream entity is reproducible from it.
 *
 * Matches the raw envelope pattern in SPEC.md §3.5 (`raw_luma_event`).
 */
export interface RawLumaEvent {
  /** Luma slug — UNIQUE in `raw_luma_event.luma_event_id`. */
  lumaEventId: string;
  /** Detail snapshot. */
  detail: ScrapedEventDetail;
  /** ISO-8601 wall-clock at which the scrape completed. */
  scrapedAt: string;
  /**
   * Source URL that was scraped. Usually `https://lu.ma/<slug>` but kept
   * explicit so we can audit alternative entry points later.
   */
  sourceUrl: string;
  /**
   * SHA-256 hex digest of the canonical detail payload. Used by the
   * normalization layer to skip work when a re-scrape produced no change.
   */
  payloadHash: string;
}
