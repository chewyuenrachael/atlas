/**
 * Barrel export for every named query helper.
 *
 * Consumers should import from `@atlas/db` rather than reaching into the
 * `queries/` folder directly when they need helpers across multiple entities.
 */
export * as PersonQueries from './person.js';
export * as CompanyQueries from './company.js';
export * as EventQueries from './event.js';
export * as CommunicationQueries from './communication.js';
export * as ArtifactQueries from './artifact.js';
export * as ProgramQueries from './program.js';
export * as SignalQueries from './signal.js';
export * as AuditQueries from './audit.js';
export * as ViewQueries from './views.js';
export * as HackerNewsQueries from './hackernews.js';
export * as RedditQueries from './reddit.js';
export * as GithubQueries from './github.js';
// Re-export the row shapes returned by mv_* views at top level so cockpit
// components can `import type { CitySignalRow } from '@atlas/db'` without
// reaching through the ViewQueries namespace.
export type {
  CitySignalRow,
  CitySignalQueryOptions,
  EventOrganizerEntry,
  EventWithOrganizersRow,
  EventsWithOrganizersQueryOptions,
  PersonActivitySummaryRow,
  ViewRefreshResult,
  RefreshAllReport,
  MaterializedViewName,
} from './views.js';
