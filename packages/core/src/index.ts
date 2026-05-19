/**
 * @atlas/core — shared types, constants, errors, Result, logger.
 *
 * This package has no runtime dependencies on other Atlas packages. Anything
 * that lives in here must be import-safe from every other workspace package,
 * including adapters running inside Inngest functions and the Next.js app.
 */
export * from './types.js';
export * from './constants.js';
export * from './errors.js';
export * from './result.js';
export * from './logger.js';
