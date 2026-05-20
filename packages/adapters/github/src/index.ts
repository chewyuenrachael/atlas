/**
 * @atlas/adapter-github — public surface.
 *
 * Two adapter modes share the package (SPEC.md §5.2.2):
 *
 *   - {@link GithubProfileAdapter} refreshes known-ambassador profiles
 *     (weekly cron).
 *   - {@link GithubRepoSearchAdapter} finds Cursor-related repos and READMEs
 *     (daily cron).
 *
 * Both adapters share the same {@link GithubClient} so we only authenticate
 * against the GitHub API once per process.
 */
export const ADAPTER_NAME = 'github';

export {
  createGithubClient,
  GithubClient,
  GITHUB_MISSING_TOKEN_CODE,
  isMissingTokenError,
  type CreateGithubClientOptions,
  type GithubOctokitLike,
  type GithubProfileResponse,
  type GithubRepoResponse,
  type RateLimitObservation,
} from './client.js';

export {
  GithubProfileAdapter,
  InMemoryRawGithubProfileStore,
  type GithubProfileAdapterOptions,
  type RawGithubProfileStore,
} from './profile-adapter.js';

export {
  GithubRepoSearchAdapter,
  InMemoryRawGithubRepoStore,
  scoreRelevance,
  type GithubRepoSearchAdapterOptions,
  type RawGithubRepoStore,
} from './repo-search-adapter.js';

export {
  computeCursorRelevance,
  mentionsCursor,
  normalizeGithubProfile,
  normalizeGithubRepoMatch,
} from './normalizer.js';

export {
  StaticAmbassadorSource,
  type AmbassadorSource,
  type CursorRelevance,
  type RawGithubProfile,
  type RawGithubRepoMatch,
  type RepoSearchOptions,
} from './types.js';
