/**
 * Public surface of `@atlas/api-ask-anything`.
 *
 * Cockpit imports `handleAsk` for the `/api/queries/natural-language`
 * route, and `CHIPS` for the chip strip at the top of `/ask`. Everything
 * else is internal.
 */
export { CHIPS, type ChipDef, findChipById } from './chips.js';
export { handleAsk, type AskRequest, type AskResponse } from './handler.js';
export { runChip, clearChipCache, type RunChipResult } from './chip-cache.js';
export { runSelect, type ColumnMeta, type QueryRunResult } from './executor.js';
export { translateQuestionToSql, type TranslateResult } from './translator.js';
