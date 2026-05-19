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
