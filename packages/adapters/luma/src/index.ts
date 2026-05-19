/**
 * @atlas/adapter-luma — public surface.
 *
 * See SPEC.md §5.2.1 (source contract) and AGENTS.md §4 (recipe).
 */
export const ADAPTER_NAME = 'luma';

export {
  LumaAdapter,
  InMemoryRawLumaStore,
  type LumaAdapterOptions,
  type RawLumaStore,
} from './adapter.js';
export { normalizeLumaEvent } from './normalizer.js';
export {
  scrapeCommunityPage,
  scrapeEventDetail,
  parseCommunityPageHtml,
  parseEventDetailHtml,
  type ScraperOptions,
} from './scraper.js';
export type {
  CommunityEventListing,
  RawLumaEvent,
  ScrapedEventDetail,
  ScrapedExternalLink,
  ScrapedExternalPlatform,
  ScrapedOrganizer,
} from './types.js';
