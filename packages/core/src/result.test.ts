import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, map, mapErr, ok, tryAsync, unwrapOr } from './result.js';

describe('Result', () => {
  it('constructs Ok and narrows correctly', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it('constructs Err and narrows correctly', () => {
    const r = err('nope' as const);
    expect(isOk(r)).toBe(false);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error).toBe('nope');
  });

  it('map transforms Ok and passes through Err', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    expect(map(err('x' as const), (n: number) => n * 3)).toEqual(err('x'));
  });

  it('mapErr transforms Err and passes through Ok', () => {
    expect(mapErr(err(1 as const), (n) => n + 1)).toEqual(err(2));
    expect(mapErr(ok('y'), (n: number) => n + 1)).toEqual(ok('y'));
  });

  it('unwrapOr returns fallback on Err', () => {
    expect(unwrapOr(ok(1), 99)).toBe(1);
    expect(unwrapOr(err('boom' as const), 99)).toBe(99);
  });

  it('tryAsync wraps thrown errors as Err', async () => {
    const success = await tryAsync(
      async () => 'good',
      (e) => `bad: ${String(e)}`,
    );
    expect(success).toEqual(ok('good'));

    const failure = await tryAsync(
      async () => {
        throw new Error('boom');
      },
      (e) => (e as Error).message,
    );
    expect(failure).toEqual(err('boom'));
  });
});
