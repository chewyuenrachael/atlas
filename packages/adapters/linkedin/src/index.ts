/**
 * LinkedIn adapter — Phase 0 scaffold only.
 *
 * Phase 2 implements:
 *   - `fetchPage` against the LinkedIn source (see SPEC.md §5.2.4)
 *   - `persistRaw` into the raw_linkedin table
 *   - `normalizeRaw` into NormalizedRecord[]
 *
 * Follow the recipe in AGENTS.md "How to add a new adapter".
 *
 * Rate limit comes from `RATE_LIMIT_DEFAULT` in @atlas/core/constants.
 */
export const ADAPTER_NAME = 'linkedin';
