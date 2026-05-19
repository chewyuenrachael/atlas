/**
 * Hacker News adapter — Phase 0 scaffold only.
 *
 * Phase 2 implements:
 *   - `fetchPage` against the Hacker News source (see SPEC.md §5.2.6)
 *   - `persistRaw` into the raw_hackernews table
 *   - `normalizeRaw` into NormalizedRecord[]
 *
 * Follow the recipe in AGENTS.md "How to add a new adapter".
 *
 * Rate limit comes from `RATE_LIMIT_HACKERNEWS` in @atlas/core/constants.
 */
export const ADAPTER_NAME = 'hackernews';
