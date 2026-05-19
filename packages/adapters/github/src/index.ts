/**
 * GitHub adapter — Phase 0 scaffold only.
 *
 * Phase 2 implements:
 *   - `fetchPage` against the GitHub source (see SPEC.md §5.2.2)
 *   - `persistRaw` into the raw_github table
 *   - `normalizeRaw` into NormalizedRecord[]
 *
 * Follow the recipe in AGENTS.md "How to add a new adapter".
 *
 * Rate limit comes from `RATE_LIMIT_GITHUB` in @atlas/core/constants.
 */
export const ADAPTER_NAME = 'github';
