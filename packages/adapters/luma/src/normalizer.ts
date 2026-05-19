/**
 * Luma normalizer — converts `RawLumaEvent` into `NormalizedRecord[]`.
 *
 * Output contract (SPEC.md §5.2.1):
 *   - One Event `NormalizedRecord` per scraped event
 *   - One Person `NormalizedRecord` per organizer observed on the event page
 *
 * Edges (person_event, person_platform_identity) are NOT emitted here — the
 * identity resolution service in Phase 1C reads NormalizedRecord[] and
 * synthesizes edges based on resolution decisions. This keeps adapters
 * agnostic of resolution policy.
 *
 * Normalization is deterministic: the same RawLumaEvent always produces the
 * same array of NormalizedRecord, byte-for-byte. Tests rely on this.
 */
import { logger, type Metadata, type NormalizedRecord } from '@atlas/core';
import type {
  RawLumaEvent,
  ScrapedEventDetail,
  ScrapedExternalLink,
  ScrapedOrganizer,
} from './types.js';

const log = logger.child({ adapter: 'luma', component: 'normalizer' });

const SOURCE_PLATFORM_LUMA = 'luma';

/**
 * Convert one raw Luma event into the canonical normalized records.
 *
 * @param raw - The raw event as stored in `raw_luma_event.raw_payload`.
 * @returns One Event record followed by N Person records (one per organizer).
 *   Returns an empty array if the raw record lacks the minimum viable fields
 *   (title or slug). Missing optional fields are populated as null.
 *
 * @example
 * ```ts
 * const records = normalizeLumaEvent(raw);
 * const events = records.filter((r) => r.recordType === 'event');
 * const persons = records.filter((r) => r.recordType === 'person');
 * ```
 */
export function normalizeLumaEvent(raw: RawLumaEvent): NormalizedRecord[] {
  if (!raw.lumaEventId) {
    log.warn({ scraped_at: raw.scrapedAt }, 'dropping raw record without luma_event_id');
    return [];
  }
  const detail = raw.detail;
  if (!detail.title || detail.title.trim().length === 0) {
    log.warn({ luma_event_id: raw.lumaEventId }, 'event missing title; skipping normalization');
    return [];
  }

  const observedAt = raw.scrapedAt;
  const out: NormalizedRecord[] = [];
  out.push(buildEventRecord(raw, detail, observedAt));
  for (const organizer of detail.organizers) {
    out.push(buildPersonRecord(organizer, raw.lumaEventId, observedAt));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event record
// ---------------------------------------------------------------------------

function buildEventRecord(
  raw: RawLumaEvent,
  detail: ScrapedEventDetail,
  observedAt: string,
): NormalizedRecord {
  const payload: Metadata = {
    luma_event_id: raw.lumaEventId,
    title: detail.title,
    description: detail.description,
    starts_at: detail.startsAt,
    ends_at: detail.endsAt,
    timezone: detail.timezone,
    venue_name: detail.venueName,
    venue_address: detail.venueAddress,
    venue_city: detail.venueCity,
    venue_country: detail.venueCountry,
    event_format: detail.eventFormat,
    registered_count: detail.registeredCount,
    cover_image_url: detail.coverImageUrl,
    source_url: raw.sourceUrl,
    status: deriveStatus(detail.startsAt, detail.endsAt, observedAt),
    organizer_handles: detail.organizers.map((o) => o.lumaHandle),
    external_links: detail.eventLinks,
    payload_hash: raw.payloadHash,
  };
  return {
    recordType: 'event',
    sourcePlatform: SOURCE_PLATFORM_LUMA,
    sourceRecordId: raw.lumaEventId,
    payload,
    observedAt,
  };
}

function deriveStatus(
  startsAt: string | null,
  endsAt: string | null,
  observedAt: string,
): 'scheduled' | 'completed' | null {
  if (!startsAt) return null;
  const now = Date.parse(observedAt);
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return null;
  const end = endsAt ? Date.parse(endsAt) : start;
  if (Number.isFinite(end) && end < now) return 'completed';
  return 'scheduled';
}

// ---------------------------------------------------------------------------
// Person record
// ---------------------------------------------------------------------------

function buildPersonRecord(
  organizer: ScrapedOrganizer,
  lumaEventId: string,
  observedAt: string,
): NormalizedRecord {
  const platformIdentities = buildPlatformIdentities(organizer);
  const payload: Metadata = {
    canonical_name: organizer.name,
    names_seen: [organizer.name],
    luma_handle: organizer.lumaHandle,
    luma_profile_url: organizer.lumaProfileUrl,
    avatar_url: organizer.avatarUrl,
    platform_identities: platformIdentities,
    observed_role: 'organizer',
    luma_event_id: lumaEventId,
  };
  return {
    recordType: 'person',
    sourcePlatform: SOURCE_PLATFORM_LUMA,
    sourceRecordId: `${lumaEventId}:${organizer.lumaHandle}`,
    payload,
    observedAt,
  };
}

interface PlatformIdentityPayload {
  platform: 'luma' | 'twitter' | 'github' | 'linkedin';
  handle: string;
  profile_url: string | null;
}

function buildPlatformIdentities(organizer: ScrapedOrganizer): PlatformIdentityPayload[] {
  const out: PlatformIdentityPayload[] = [];
  out.push({
    platform: 'luma',
    handle: organizer.lumaHandle,
    profile_url: organizer.lumaProfileUrl,
  });
  for (const link of organizer.externalLinks) {
    const platform = mapExternalPlatform(link);
    if (!platform) continue;
    const handle = link.handle ?? organizer.lumaHandle;
    out.push({ platform, handle, profile_url: link.url });
  }
  return dedupeIdentities(out);
}

function mapExternalPlatform(link: ScrapedExternalLink): 'twitter' | 'github' | 'linkedin' | null {
  if (link.platform === 'twitter') return 'twitter';
  if (link.platform === 'github') return 'github';
  if (link.platform === 'linkedin') return 'linkedin';
  return null;
}

function dedupeIdentities(items: PlatformIdentityPayload[]): PlatformIdentityPayload[] {
  const seen = new Map<string, PlatformIdentityPayload>();
  for (const item of items) {
    const key = `${item.platform}:${item.handle.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}
