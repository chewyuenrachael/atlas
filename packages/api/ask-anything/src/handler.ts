/**
 * High-level handler for `POST /api/queries/natural-language`.
 *
 * Two code paths:
 *   - `chipId` set → serve from chip cache (instant; logs as `cached: true`)
 *   - free-form `question` → translate via Claude → execute → log
 *
 * Always returns a structured response shape so the cockpit can render a
 * consistent table + status bar regardless of which path ran.
 */
import { runChip } from './chip-cache.js';
import type { ColumnMeta } from './executor.js';
import { logQuery, runSelect } from './executor.js';
import { translateQuestionToSql } from './translator.js';

export interface AskRequest {
  question?: string;
  chipId?: string;
  userId?: string;
}

export interface AskResponse {
  ok: boolean;
  /** SQL that was executed. Empty string for chip cache hits that don't expose SQL. */
  sql: string;
  question: string;
  cached: boolean;
  rows: Array<Record<string, unknown>>;
  columns: ColumnMeta[];
  rowCount: number;
  executionMs: number;
  translationMs?: number;
  /** Free-text demo callout for chip queries; absent for free-form. */
  demoCallout?: string;
  errorMessage?: string;
}

export async function handleAsk(req: AskRequest): Promise<AskResponse> {
  if (req.chipId) {
    const chipResult = await runChip(req.chipId);
    if (!chipResult) {
      return {
        ok: false,
        sql: '',
        question: req.question ?? '',
        cached: false,
        rows: [],
        columns: [],
        rowCount: 0,
        executionMs: 0,
        errorMessage: `Unknown chip "${req.chipId}".`,
      };
    }
    // Log every chip run (the cache speeds the query, not the audit row).
    void logQuery({
      question: chipResult.chip.question,
      sql: chipResult.chip.sql,
      cached: chipResult.cached,
      chipId: chipResult.chip.id,
      result: chipResult.result,
      ...(req.userId ? { userId: req.userId } : {}),
    });
    return {
      ok: chipResult.result.ok,
      sql: chipResult.chip.sql,
      question: chipResult.chip.question,
      cached: chipResult.cached,
      rows: chipResult.result.rows,
      columns: chipResult.result.columns,
      rowCount: chipResult.result.rowCount,
      executionMs: chipResult.result.executionMs,
      demoCallout: chipResult.chip.demoCallout,
      ...(chipResult.result.errorMessage
        ? { errorMessage: chipResult.result.errorMessage }
        : {}),
    };
  }

  const question = (req.question ?? '').trim();
  if (!question) {
    return {
      ok: false,
      sql: '',
      question: '',
      cached: false,
      rows: [],
      columns: [],
      rowCount: 0,
      executionMs: 0,
      errorMessage: 'Empty question — type something or click a chip.',
    };
  }

  const translation = await translateQuestionToSql(question);
  if (!translation.ok || !translation.sql) {
    void logQuery({
      question,
      sql: '',
      cached: false,
      chipId: null,
      result: {
        ok: false,
        rows: [],
        columns: [],
        rowCount: 0,
        executionMs: 0,
        errorMessage: translation.errorMessage,
      },
      ...(req.userId ? { userId: req.userId } : {}),
    });
    return {
      ok: false,
      sql: '',
      question,
      cached: false,
      rows: [],
      columns: [],
      rowCount: 0,
      executionMs: 0,
      translationMs: translation.translationMs,
      errorMessage: translation.errorMessage ?? "I couldn't translate that question, try rephrasing.",
    };
  }

  const executed = await runSelect(translation.sql);
  await logQuery({
    question,
    sql: translation.sql,
    cached: false,
    chipId: null,
    result: executed,
    ...(req.userId ? { userId: req.userId } : {}),
  });
  return {
    ok: executed.ok,
    sql: translation.sql,
    question,
    cached: false,
    rows: executed.rows,
    columns: executed.columns,
    rowCount: executed.rowCount,
    executionMs: executed.executionMs,
    translationMs: translation.translationMs,
    ...(executed.errorMessage ? { errorMessage: executed.errorMessage } : {}),
  };
}
