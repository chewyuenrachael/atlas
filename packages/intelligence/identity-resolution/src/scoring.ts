/**
 * Confidence scoring — Tier 2.
 *
 * Implements the weighted-average + corroboration-boost formula from
 * SPEC.md §4.2 exactly, with two documented edge-case behaviors:
 *
 *   1. Empty signal list returns 0 (vacuous evidence is not a match).
 *   2. A single signal does not earn the corroboration boost. The SPEC's
 *      `0.03 * distinctSignalTypes` formula would award 0.03 even to a
 *      single weak signal, which contradicts the "corroboration premium"
 *      semantics. TODO(spec): confirm with stakeholders; current behavior
 *      matches the task description and is the more conservative choice.
 *
 * Spec ref: SPEC.md §4.2.
 */
import {
  RESOLUTION_CORROBORATION_BOOST_MAX,
  RESOLUTION_CORROBORATION_BOOST_PER_SIGNAL,
  type ResolutionSignal,
} from '@atlas/core';

/**
 * Compute the weighted match confidence for a list of resolution signals.
 *
 * @param signals - Non-empty list of signals from {@link extractAllSignals}.
 *                  Weights come from `RESOLUTION_SIGNAL_WEIGHTS`.
 * @returns Confidence in [0, 1]. 0 for the empty list.
 *
 * @example
 * ```ts
 * const conf = computeMatchConfidence([
 *   { signalType: 'email_exact', weight: 0.95, confidence: 1 },
 * ]);
 * if (conf >= 0.85) await mergePerson(...);
 * ```
 */
export function computeMatchConfidence(signals: readonly ResolutionSignal[]): number {
  if (signals.length === 0) return 0;

  let sumWeighted = 0;
  let sumWeights = 0;
  for (const s of signals) {
    sumWeighted += s.weight * s.confidence;
    sumWeights += s.weight;
  }
  if (sumWeights === 0) return 0;

  const baseScore = sumWeighted / sumWeights;

  const distinctSignalTypes = new Set(signals.map((s) => s.signalType)).size;
  const corroborationBoost =
    distinctSignalTypes <= 1
      ? 0
      : Math.min(
          RESOLUTION_CORROBORATION_BOOST_MAX,
          RESOLUTION_CORROBORATION_BOOST_PER_SIGNAL * distinctSignalTypes,
        );

  return Math.min(1, baseScore + corroborationBoost);
}
