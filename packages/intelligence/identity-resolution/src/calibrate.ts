/**
 * Calibration script for the Tier 1 + Tier 2 identity resolver.
 *
 * Runs the resolver against every fixture in `__fixtures__/index.ts` and
 * prints:
 *
 *   - True positive rate  (expected merge → actual merge to the right person)
 *   - False positive rate (expected non-merge → actual merge)
 *   - True negative rate  (expected non-merge → actual non-merge)
 *   - False negative rate (expected merge   → actual non-merge / wrong merge)
 *   - Confidence-distribution histogram (10 buckets of width 0.1)
 *   - Top 3 cases the resolver got wrong, for future weight tuning
 *
 * This is the calibration surface. Tweaking `RESOLUTION_SIGNAL_WEIGHTS`
 * in `@atlas/core/constants`, the corroboration boost, or the decision
 * thresholds should be done with this script in hand: re-run after each
 * change and confirm the buckets move in the expected direction.
 *
 * Spec ref: SPEC.md §4.2 (signal weights), §4.4 (audit), §11 Phase 1.
 *
 * @example
 * ```bash
 * pnpm tsx packages/intelligence/identity-resolution/src/calibrate.ts
 * ```
 */
import { isOk } from '@atlas/core';

import { ALL_FIXTURES, type ResolutionFixture } from './__fixtures__/index.js';
import { IdentityResolver } from './resolver.js';
import { InMemoryPersonStore } from './store.js';

interface FixtureRun {
  fixture: ResolutionFixture;
  actualAction: 'merge' | 'create_new' | 'human_review' | 'skip' | 'error';
  actualPersonId: string | null;
  confidence: number;
  correct: boolean;
}

interface CalibrationReport {
  totals: {
    fixtures: number;
    correct: number;
    accuracy: number;
  };
  rates: {
    truePositive: number;
    falsePositive: number;
    trueNegative: number;
    falseNegative: number;
  };
  confidenceHistogram: Record<string, number>;
  topWrong: Array<{
    id: string;
    description: string;
    expected: string;
    expectedPerson?: string | undefined;
    actual: string;
    actualPerson: string | null;
    confidence: number;
  }>;
}

/**
 * Run every fixture against a fresh resolver instance and collect outcomes.
 *
 * Exported so unit tests / downstream tooling can run the same accounting
 * without shelling out to a script.
 */
export async function runCalibration(
  fixtures: readonly ResolutionFixture[] = ALL_FIXTURES,
): Promise<CalibrationReport> {
  const runs: FixtureRun[] = [];

  for (const fixture of fixtures) {
    InMemoryPersonStore.resetIdCounter();
    const store = new InMemoryPersonStore();
    for (const seed of fixture.seeded) store.seedPerson(seed);
    const resolver = new IdentityResolver({ store, audit: store });

    const result = await resolver.resolve(fixture.record);
    if (!isOk(result)) {
      runs.push({
        fixture,
        actualAction: 'error',
        actualPersonId: null,
        confidence: 0,
        correct: false,
      });
      continue;
    }

    const actual = result.value;
    const expectedPerson = fixture.expected.matchedPersonId;
    const matchedExpectedPerson = !expectedPerson || actual.personId === expectedPerson;
    const correct = actual.action === fixture.expected.action && matchedExpectedPerson;

    runs.push({
      fixture,
      actualAction: actual.action,
      actualPersonId: actual.personId,
      confidence: actual.confidence,
      correct,
    });
  }

  const correct = runs.filter((r) => r.correct).length;
  const total = runs.length;
  const accuracy = total === 0 ? 0 : correct / total;

  // TP / FP / TN / FN bookkeeping using merge as the "positive" class.
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  for (const r of runs) {
    const expectedMerge = r.fixture.expected.action === 'merge';
    const actualMerge = r.actualAction === 'merge';
    const correctMerge =
      actualMerge &&
      (!r.fixture.expected.matchedPersonId ||
        r.actualPersonId === r.fixture.expected.matchedPersonId);
    if (expectedMerge && correctMerge) truePositive += 1;
    else if (!expectedMerge && actualMerge) falsePositive += 1;
    else if (!expectedMerge && !actualMerge) trueNegative += 1;
    else if (expectedMerge && !correctMerge) falseNegative += 1;
  }

  const histogram = buildConfidenceHistogram(runs.map((r) => r.confidence));
  const topWrong = runs
    .filter((r) => !r.correct)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((r) => ({
      id: r.fixture.id,
      description: r.fixture.description,
      expected: r.fixture.expected.action,
      expectedPerson: r.fixture.expected.matchedPersonId,
      actual: r.actualAction,
      actualPerson: r.actualPersonId,
      confidence: round2(r.confidence),
    }));

  return {
    totals: { fixtures: total, correct, accuracy: round3(accuracy) },
    rates: {
      truePositive,
      falsePositive,
      trueNegative,
      falseNegative,
    },
    confidenceHistogram: histogram,
    topWrong,
  };
}

function buildConfidenceHistogram(values: readonly number[]): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (let i = 0; i < 10; i += 1) {
    const lo = (i / 10).toFixed(1);
    const hi = ((i + 1) / 10).toFixed(1);
    buckets[`[${lo}-${hi})`] = 0;
  }
  buckets['[1.0]'] = 0;
  for (const v of values) {
    const clamped = Math.max(0, Math.min(1, v));
    if (clamped === 1) {
      buckets['[1.0]'] = (buckets['[1.0]'] ?? 0) + 1;
      continue;
    }
    const idx = Math.floor(clamped * 10);
    const lo = (idx / 10).toFixed(1);
    const hi = ((idx + 1) / 10).toFixed(1);
    const key = `[${lo}-${hi})`;
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  return buckets;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * CLI entry point. Renders the report as JSON to stdout plus a short
 * human-readable summary to stderr. `pnpm tsx calibrate.ts > report.json`
 * keeps machine-readable output clean while the summary stays visible.
 */
async function main(): Promise<void> {
  const report = await runCalibration();

  process.stderr.write('=== Identity Resolution Calibration ===\n');
  process.stderr.write(
    `Fixtures: ${report.totals.fixtures}  ` +
      `Correct: ${report.totals.correct}  ` +
      `Accuracy: ${(report.totals.accuracy * 100).toFixed(1)}%\n`,
  );
  process.stderr.write(
    `TP: ${report.rates.truePositive}  ` +
      `FP: ${report.rates.falsePositive}  ` +
      `TN: ${report.rates.trueNegative}  ` +
      `FN: ${report.rates.falseNegative}\n\n`,
  );

  process.stderr.write('Confidence distribution:\n');
  for (const [bucket, count] of Object.entries(report.confidenceHistogram)) {
    const bar = '█'.repeat(count);
    process.stderr.write(`  ${bucket.padEnd(10)} ${count.toString().padStart(3)}  ${bar}\n`);
  }

  if (report.topWrong.length > 0) {
    process.stderr.write('\nTop wrong cases (highest confidence first):\n');
    for (const wrong of report.topWrong) {
      process.stderr.write(
        `  - ${wrong.id} (conf=${wrong.confidence.toFixed(2)})\n` +
          `      expected=${wrong.expected}` +
          (wrong.expectedPerson ? ` → ${wrong.expectedPerson}` : '') +
          `\n` +
          `      actual=${wrong.actual}` +
          (wrong.actualPerson ? ` → ${wrong.actualPerson}` : '') +
          `\n` +
          `      ${wrong.description}\n`,
      );
    }
  } else {
    process.stderr.write('\nNo wrong cases — all fixtures resolved as expected.\n');
  }

  process.stdout.write(JSON.stringify(report, null, 2));
  process.stdout.write('\n');
}

// Run when invoked as a script (not when imported by a test).
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /calibrate\.(ts|js|mjs|cjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`calibration failed: ${message}\n`);
    process.exitCode = 1;
  });
}
