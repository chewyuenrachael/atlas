/**
 * Result<T, E> — explicit success/failure values instead of thrown exceptions.
 *
 * Every async function that crosses a module boundary should return
 * `Promise<Result<T, AtlasError>>` rather than throwing. See `.cursor/rules`
 * and AGENTS.md for the rationale.
 *
 * @example
 * ```ts
 * async function findPerson(id: string): Promise<Result<Person, QueryError>> {
 *   const row = await db.persons.findById(id);
 *   if (!row) return err(new QueryError('not found', 'PERSON_NOT_FOUND'));
 *   return ok(row);
 * }
 *
 * const result = await findPerson(id);
 * if (isErr(result)) {
 *   logger.warn({ err: result.error }, 'person lookup failed');
 *   return;
 * }
 * console.log(result.value.canonicalName);
 * ```
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

/** Construct a successful result. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Construct a failed result. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Narrowing predicate: true iff result is `Ok`. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Narrowing predicate: true iff result is `Err`. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Transform the success value, preserving the error. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Transform the error value, preserving the success. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Extract the success value or fall back to a default. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Run an async fn, catching synchronous and asynchronous throws and converting
 * them to `Err`. Use sparingly: prefer functions that natively return Result.
 */
export async function tryAsync<T, E>(
  fn: () => Promise<T>,
  onError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(onError(cause));
  }
}
