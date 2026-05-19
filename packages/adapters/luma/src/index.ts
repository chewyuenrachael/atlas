/**
 * Luma adapter — Phase 0 scaffold only.
 *
 * Phase 2 implements:
 *   - `fetchPage` against the Luma source (see SPEC.md §5.2.1)
 *   - `persistRaw` into the raw_luma table
 *   - `normalizeRaw` into NormalizedRecord[]
 *
 * Follow the recipe in AGENTS.md "How to add a new adapter".
 *
 * Rate limit comes from `RATE_LIMIT_LUMA` in @atlas/core/constants.
 */
export const ADAPTER_NAME = 'luma';
