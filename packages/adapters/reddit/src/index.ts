/**
 * @atlas/adapter-reddit — public surface.
 *
 * See SPEC.md §5.2.5 (source contract) and AGENTS.md §4 (recipe).
 */
export const ADAPTER_NAME = 'reddit';

export {
  RedditAdapter,
  InMemoryRawRedditStore,
  DEFAULT_SUBREDDITS,
  type RedditAdapterOptions,
  type RedditAdapterDeps,
  type RawRedditStore,
} from './adapter.js';
export { SupabaseRawRedditStore } from './store-supabase.js';
export { normalizeRedditItem } from './normalizer.js';
export { computeCursorRelevance } from './relevance.js';
export {
  searchSubreddit,
  fetchPostWithComments,
  parseSearchListing,
  parsePostThread,
  type ClientOptions,
  type SearchOptions,
} from './client.js';
export type {
  CursorRelevance,
  RawRedditItem,
  RedditCommentData,
  RedditEnvelope,
  RedditPostData,
  RedditThingKind,
} from './types.js';
