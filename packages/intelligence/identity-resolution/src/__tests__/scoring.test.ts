/**
 * Unit tests for `computeMatchConfidence` (SPEC.md §4.2 formula).
 *
 * Covers:
 *   - Empty signals → 0.
 *   - Single-signal sanity (no corroboration boost).
 *   - Weighted-average correctness across mixed signal types.
 *   - Corroboration boost cap (≤ 0.15) and per-distinct-type increment.
 *   - Confidence clamped to [0, 1].
 *   - Boundary points at the merge / human-review thresholds.
 */
import { describe, expect, it } from 'vitest';

import {
  RESOLUTION_AUTO_MERGE_THRESHOLD,
  RESOLUTION_CORROBORATION_BOOST_MAX,
  RESOLUTION_HUMAN_REVIEW_THRESHOLD,
  RESOLUTION_SIGNAL_WEIGHTS,
  type ResolutionSignal,
} from '@atlas/core';

import { computeMatchConfidence } from '../scoring.js';

function sig(
  signalType: keyof typeof RESOLUTION_SIGNAL_WEIGHTS,
  confidence: number,
): ResolutionSignal {
  return {
    signalType,
    weight: RESOLUTION_SIGNAL_WEIGHTS[signalType],
    confidence,
  };
}

describe('computeMatchConfidence', () => {
  it('returns 0 for an empty signal list', () => {
    expect(computeMatchConfidence([])).toBe(0);
  });

  it('returns 0 when every weight is 0 (guards against div-by-zero)', () => {
    expect(computeMatchConfidence([{ signalType: 'name_fuzzy', weight: 0, confidence: 1 }])).toBe(
      0,
    );
  });

  it('does not apply corroboration boost to a single signal', () => {
    const score = computeMatchConfidence([sig('email_exact', 1)]);
    // (0.95 * 1) / 0.95 = 1.0, single signal → no boost, cap at 1.
    expect(score).toBeCloseTo(1, 6);
  });

  it('clamps the result to 1.0', () => {
    const score = computeMatchConfidence([
      sig('email_exact', 1),
      sig('name_exact', 1),
      sig('employer_match', 1),
      sig('city_match', 1),
      sig('timezone_overlap', 1),
    ]);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0.99);
  });

  it('applies the corroboration boost per distinct signal type', () => {
    // 3 distinct types → boost = 0.03 * 3 = 0.09.
    const score = computeMatchConfidence([
      sig('name_exact', 1),
      sig('employer_match', 1),
      sig('city_match', 1),
    ]);
    // sumWeighted = 0.4 + 0.3 + 0.2 = 0.9; sumWeights = 0.9; base = 1.0.
    // base + 0.09 = 1.09, clamped to 1.
    expect(score).toBeCloseTo(1, 6);
  });

  it('caps the corroboration boost at 0.15', () => {
    // 6 distinct types would award 0.18, but the cap is 0.15.
    const signals: ResolutionSignal[] = [
      { signalType: 'name_fuzzy', weight: 1, confidence: 0.6 },
      { signalType: 'email_domain', weight: 1, confidence: 0.6 },
      { signalType: 'employer_match', weight: 1, confidence: 0.6 },
      { signalType: 'city_match', weight: 1, confidence: 0.6 },
      { signalType: 'timezone_overlap', weight: 1, confidence: 0.6 },
      { signalType: 'mutual_connection', weight: 1, confidence: 0.6 },
    ];
    const score = computeMatchConfidence(signals);
    // baseScore is exactly 0.6 (all same confidence); boost ≤ 0.15.
    const expectedBase = 0.6;
    expect(score).toBeGreaterThanOrEqual(expectedBase + 0.14999);
    expect(score).toBeLessThanOrEqual(expectedBase + RESOLUTION_CORROBORATION_BOOST_MAX + 1e-9);
  });

  it('weighted-average matches the SPEC formula on a mixed input', () => {
    const signals = [sig('name_fuzzy', 0.5), sig('employer_match', 1), sig('city_match', 1)];
    // sumWeighted = 0.2*0.5 + 0.3*1 + 0.2*1 = 0.6
    // sumWeights = 0.7. base = 6/7 ≈ 0.857. boost = 0.09. final ≈ 0.947.
    const score = computeMatchConfidence(signals);
    expect(score).toBeCloseTo(0.6 / 0.7 + 0.09, 6);
    expect(score).toBeGreaterThanOrEqual(RESOLUTION_AUTO_MERGE_THRESHOLD);
  });

  it('boundary: fuzzy name + city + country-free crosses the merge floor', () => {
    // Designed to drop near the human-review band: fuzzy(0.5)+city(1) →
    // base = 0.75, +boost 0.06 = 0.81 (< 0.85 → human_review).
    const signals = [sig('name_fuzzy', 0.5), sig('city_match', 1)];
    const score = computeMatchConfidence(signals);
    expect(score).toBeGreaterThanOrEqual(RESOLUTION_HUMAN_REVIEW_THRESHOLD);
    expect(score).toBeLessThan(RESOLUTION_AUTO_MERGE_THRESHOLD);
  });

  it('conflicting signals do not cancel — formula is monotonic in evidence', () => {
    const low = computeMatchConfidence([sig('name_fuzzy', 0.5)]);
    const more = computeMatchConfidence([sig('name_fuzzy', 0.5), sig('timezone_overlap', 1)]);
    expect(more).toBeGreaterThan(low);
  });

  it('single low-weight signal still produces baseScore = 1 when confidence is 1', () => {
    // Documented edge of the SPEC formula: weighted average over one
    // signal degenerates to the confidence. The corroboration cap rescues
    // us only when other signals exist. This test pins down the formula
    // semantics so behavior changes are loud.
    const score = computeMatchConfidence([sig('timezone_overlap', 1)]);
    expect(score).toBe(1);
  });
});
