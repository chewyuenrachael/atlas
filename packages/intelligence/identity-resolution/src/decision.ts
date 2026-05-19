/**
 * Decision engine — translate a top-candidate confidence into a
 * {@link ResolutionAction}.
 *
 * Thresholds are imported from `@atlas/core/constants` so the resolver and
 * any future tuning surface read the same numbers.
 *
 * Spec ref: SPEC.md §4.2 (Thresholds), §4.3 (Decision Engine).
 */
import {
  RESOLUTION_AUTO_MERGE_THRESHOLD,
  RESOLUTION_HUMAN_REVIEW_THRESHOLD,
  type ResolutionAction,
} from '@atlas/core';

/**
 * Pick the action given top confidence and whether any candidates existed.
 *
 * - confidence >= 0.85: `merge` (auto)
 * - 0.65 <= confidence < 0.85: `human_review`
 * - confidence < 0.65 AND no candidates: `create_new`
 * - confidence < 0.65 AND candidates exist: `skip` (don't merge, don't
 *   create — surface for review so we don't make a duplicate Person).
 *
 * @example
 * ```ts
 * decideAction(0.91, 1);  // 'merge'
 * decideAction(0.72, 1);  // 'human_review'
 * decideAction(0.0, 0);   // 'create_new'
 * decideAction(0.3, 2);   // 'skip'
 * ```
 */
export function decideAction(confidence: number, candidateCount: number): ResolutionAction {
  if (confidence >= RESOLUTION_AUTO_MERGE_THRESHOLD) return 'merge';
  if (confidence >= RESOLUTION_HUMAN_REVIEW_THRESHOLD) return 'human_review';
  if (candidateCount === 0) return 'create_new';
  return 'skip';
}
