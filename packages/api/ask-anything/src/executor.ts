/**
 * Execute a SELECT-only SQL string against the Atlas via the
 * `atlas_run_select` Postgres function. Returns rows + execution time +
 * inferred column metadata. Logs every attempt to `query_log`.
 */
import { getServiceClient } from '@atlas/db';

export interface ColumnMeta {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'null';
}

export interface QueryRunResult {
  ok: boolean;
  rows: Array<Record<string, unknown>>;
  columns: ColumnMeta[];
  rowCount: number;
  executionMs: number;
  errorMessage?: string;
}

const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Run an arbitrary read-only SELECT against the Atlas. Errors are returned
 * as `ok: false` with a user-friendly `errorMessage` — the caller MUST NOT
 * leak this to the UI without first checking.
 */
export async function runSelect(
  sql: string,
  options?: { maxRows?: number; timeoutMs?: number },
): Promise<QueryRunResult> {
  const start = Date.now();
  const svc = getServiceClient();
  if (!svc.ok) {
    return {
      ok: false,
      rows: [],
      columns: [],
      rowCount: 0,
      executionMs: Date.now() - start,
      errorMessage: 'database client not configured',
    };
  }
  const sb = svc.value;
  const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const rpc = await sb.rpc('atlas_run_select', {
    sql_text: sql,
    max_rows: maxRows,
    timeout_ms: timeoutMs,
  });
  const executionMs = Date.now() - start;

  if (rpc.error) {
    return {
      ok: false,
      rows: [],
      columns: [],
      rowCount: 0,
      executionMs,
      errorMessage: friendlyError(rpc.error.message),
    };
  }
  const rows = (rpc.data ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    rows,
    columns: inferColumns(rows),
    rowCount: rows.length,
    executionMs,
  };
}

/**
 * Persist a query attempt for audit. Failures here are logged silently —
 * we never break the user's request because audit failed.
 */
export async function logQuery(input: {
  question: string | null;
  sql: string;
  cached: boolean;
  chipId: string | null;
  result: QueryRunResult;
  userId?: string;
}): Promise<void> {
  const svc = getServiceClient();
  if (!svc.ok) return;
  await svc.value
    .from('query_log')
    .insert({
      user_id: input.userId ?? null,
      question: input.question,
      sql: input.sql,
      cached: input.cached,
      chip_id: input.chipId,
      row_count: input.result.rowCount,
      execution_ms: input.result.executionMs,
      succeeded: input.result.ok,
      error_message: input.result.errorMessage ?? null,
    })
    .then(() => undefined, () => undefined);
}

function inferColumns(rows: Array<Record<string, unknown>>): ColumnMeta[] {
  if (rows.length === 0) return [];
  const first = rows[0]!;
  const out: ColumnMeta[] = [];
  for (const key of Object.keys(first)) {
    out.push({ name: key, type: detectType(rows, key) });
  }
  return out;
}

function detectType(rows: Array<Record<string, unknown>>, key: string): ColumnMeta['type'] {
  for (const row of rows) {
    const v = row[key];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'string') {
      // ISO 8601 timestamp heuristic
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return 'date';
      return 'string';
    }
    if (typeof v === 'object') return 'json';
  }
  return 'null';
}

/**
 * Translate raw Postgres error text into something a demo audience can read.
 * Never propagate raw SQL state codes or internal stack frames.
 */
function friendlyError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('statement timeout') || lower.includes('canceling statement')) {
    return 'That query timed out — try a tighter filter or LIMIT.';
  }
  if (lower.includes('multi-statement')) {
    return 'Multiple SQL statements are not allowed.';
  }
  if (lower.includes('must start with select')) {
    return 'Only read-only SELECT queries are supported.';
  }
  if (lower.includes('does not exist')) {
    return 'A table or column in the query is unknown. Try rephrasing.';
  }
  if (lower.includes('syntax error')) {
    return 'I produced invalid SQL. Try rephrasing the question.';
  }
  // Default: a single short line, scrubbed of any sql state code.
  const firstLine = message.split('\n')[0] ?? message;
  return firstLine.replace(/^error:\s*/i, '').slice(0, 200);
}
