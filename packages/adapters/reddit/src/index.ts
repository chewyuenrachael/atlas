/**
 * Reddit adapter — Phase 0 scaffold only.
 *
 * Phase 2 implements:
 *   - `fetchPage` against the Reddit source (see SPEC.md §5.2.5)
 *   - `persistRaw` into the raw_reddit table
 *   - `normalizeRaw` into NormalizedRecord[]
 *
 * Follow the recipe in AGENTS.md "How to add a new adapter".
 *
 * Rate limit comes from `RATE_LIMIT_REDDIT` in @atlas/core/constants.
 */
export const ADAPTER_NAME = 'reddit';
