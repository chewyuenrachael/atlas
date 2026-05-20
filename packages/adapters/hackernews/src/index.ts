/**
 * @atlas/adapter-hackernews — public surface.
 *
 * See SPEC.md §5.2.6 (source contract) and AGENTS.md §4 (recipe).
 */
export const ADAPTER_NAME = 'hackernews';

export {
  HackerNewsAdapter,
  InMemoryRawHackerNewsStore,
  type HackerNewsAdapterOptions,
  type RawHackerNewsStore,
} from './adapter.js';
export { SupabaseRawHackerNewsStore } from './store-supabase.js';
export {
  AlgoliaHackerNewsClient,
  ALGOLIA_HN_BASE_URL,
  DEFAULT_HN_QUERY,
  DEFAULT_HN_TAGS,
  DEFAULT_HITS_PER_PAGE,
  type AlgoliaHackerNewsClientOptions,
  type SearchParams,
} from './client.js';
export {
  normalizeHackerNewsItem,
  classifyItemType,
  isDeletedOrDead,
  hnUserProfileUrl,
  hnItemPermalink,
} from './normalizer.js';
export type {
  HackerNewsAlgoliaHit,
  HackerNewsAlgoliaResponse,
  HackerNewsItemType,
  RawHackerNewsItem,
} from './types.js';
