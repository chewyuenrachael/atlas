/**
 * Structured JSON logger built on Pino.
 *
 * Log schema matches SPEC.md §9.1:
 *   timestamp, level, service, trace_id, span_id, correlation_id?,
 *   entity_id?, user_id?, message, metadata?
 *
 * Use child loggers to attach correlation context to a chain of work:
 *
 * @example
 * ```ts
 * import { logger } from '@atlas/core';
 *
 * const log = logger.child({ trace_id: traceId, service: 'luma-adapter' });
 * log.info({ entity_id: personId }, 'normalized luma attendee');
 * log.error({ err }, 'failed to fetch event roster');
 * ```
 */
import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';
import { isAtlasError } from './errors.js';

const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';
const SERVICE_NAME = process.env['SERVICE_NAME'] ?? 'atlas';
const ATLAS_ENV = process.env['ATLAS_ENV'] ?? 'development';

const baseOptions: LoggerOptions = {
  level: LOG_LEVEL,
  base: {
    service: SERVICE_NAME,
    env: ATLAS_ENV,
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  // Pretty-print in dev, raw JSON in production.
  ...(ATLAS_ENV === 'development'
    ? {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }
    : {}),
  serializers: {
    err: (e: unknown) => {
      if (isAtlasError(e)) return e.toJSON();
      if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
      return { value: e };
    },
  },
};

export type Logger = PinoLogger;

/**
 * Root logger. Prefer `logger.child({ ... })` over using this directly so
 * downstream logs carry the right correlation fields.
 */
export const logger: Logger = pino(baseOptions);

/**
 * Build a child logger with a correlation id pre-populated. Convenience for
 * adapter / workflow entry points.
 */
export function withCorrelation(correlationId: string, fields: Record<string, unknown> = {}): Logger {
  return logger.child({ correlation_id: correlationId, ...fields });
}
