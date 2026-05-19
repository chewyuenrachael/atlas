/**
 * AtlasError class hierarchy.
 *
 * Every error that crosses a module boundary inside Atlas is an instance of
 * `AtlasError`. Errors carry a stable `code` (machine-readable), a `message`
 * (human-readable), and an optional structured `context` for logging.
 *
 * Errors are never thrown across module boundaries — they are returned via
 * `Result<T, AtlasError>`. See `result.ts` and `.cursor/rules`.
 */

export const ATLAS_ERROR_CODES = [
  // Ingestion / adapter
  'INGESTION_FAILED',
  'INGESTION_RATE_LIMITED',
  'INGESTION_AUTH_FAILED',
  'INGESTION_NOT_FOUND',
  // Normalization
  'NORMALIZATION_FAILED',
  'NORMALIZATION_INVALID_PAYLOAD',
  'NORMALIZATION_MISSING_FIELD',
  // Identity resolution
  'RESOLUTION_CONFLICT',
  'RESOLUTION_AMBIGUOUS',
  'RESOLUTION_INTERNAL_ERROR',
  // Query / database
  'QUERY_FAILED',
  'QUERY_TIMEOUT',
  'QUERY_NOT_FOUND',
  'QUERY_VALIDATION_FAILED',
  // Workflow
  'WORKFLOW_STEP_FAILED',
  'WORKFLOW_TIMEOUT',
  'WORKFLOW_INVALID_STATE',
  // External / unexpected
  'EXTERNAL_API_ERROR',
  'NETWORK_ERROR',
  'INTERNAL_ERROR',
  'NOT_IMPLEMENTED',
  'INVALID_CONFIG',
] as const;

export type AtlasErrorCode = (typeof ATLAS_ERROR_CODES)[number];

/**
 * Base class for all Atlas errors. Use a subclass (`IngestionError`,
 * `QueryError`, etc.) rather than constructing `AtlasError` directly.
 *
 * @example
 * ```ts
 * return err(new QueryError('person not found', 'QUERY_NOT_FOUND', { id }));
 * ```
 */
export class AtlasError extends Error {
  public readonly code: AtlasErrorCode;
  public readonly context: Record<string, unknown>;
  public override readonly cause?: unknown;

  constructor(
    message: string,
    code: AtlasErrorCode,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.context = context;
    if (cause !== undefined) this.cause = cause;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }

  /** Serialize for structured logging. Drops `stack` for brevity. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

/** Failure inside a source adapter (Luma, GitHub, Twitter, etc.). */
export class IngestionError extends AtlasError {}

/** Failure mapping a raw record onto the canonical schema. */
export class NormalizationError extends AtlasError {}

/** Failure inside the identity resolution pipeline (`packages/intelligence/identity-resolution`). */
export class ResolutionError extends AtlasError {}

/** Failure executing a database query (`packages/db/queries/*`). */
export class QueryError extends AtlasError {}

/** Failure inside an Inngest workflow step (`packages/workflows`). */
export class WorkflowError extends AtlasError {}

/** Failure calling an external API outside of an adapter context. */
export class ExternalApiError extends AtlasError {}

/** Configuration loaded from env vars is missing or invalid. */
export class ConfigError extends AtlasError {}

/** Convenience type-guard. */
export function isAtlasError(value: unknown): value is AtlasError {
  return value instanceof AtlasError;
}

/**
 * Wrap an unknown thrown value as an AtlasError. Use at adapter boundaries
 * where third-party SDKs throw arbitrary exceptions.
 */
export function fromUnknown(
  cause: unknown,
  code: AtlasErrorCode = 'INTERNAL_ERROR',
  context: Record<string, unknown> = {},
): AtlasError {
  if (isAtlasError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AtlasError(message, code, context, cause);
}
