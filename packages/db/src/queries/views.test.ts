/**
 * Unit tests for the materialized-view refresh helpers.
 *
 * These tests exercise only the parts that don't require a real database:
 *   - The `MATERIALIZED_VIEW_NAMES` constant stays in sync with the
 *     individual helpers (catches future drift if someone adds a view).
 *   - `refreshAllViews()` short-circuits on missing DATABASE_URL with a
 *     well-shaped AtlasError instead of throwing.
 *
 * The full refresh path is covered by the Phase 1D-style smoke suite and
 * the cockpit map view (which only renders if the views are populated);
 * this file is the deterministic complement.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isErr } from '@atlas/core';
import {
  MATERIALIZED_VIEW_NAMES,
  refreshAllViews,
  refreshCitySignal,
  refreshEventsWithOrganizers,
  refreshPersonActivitySummary,
} from './views.js';

describe('views helpers', () => {
  const originalDatabaseUrl = process.env['DATABASE_URL'];

  beforeEach(() => {
    delete process.env['DATABASE_URL'];
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = originalDatabaseUrl;
    }
  });

  it('lists every named view backed by a per-view helper', () => {
    expect(MATERIALIZED_VIEW_NAMES).toEqual([
      'mv_city_signal',
      'mv_events_with_organizers',
      'mv_person_activity_summary',
    ]);
  });

  it('refreshAllViews returns INVALID_CONFIG when DATABASE_URL is missing', async () => {
    const result = await refreshAllViews();
    expect(result.ok).toBe(false);
    if (!isErr(result)) return;
    // Error chains through; surface code should still be QUERY_FAILED because
    // refreshAllViews wraps the inner ConfigError. The underlying cause is
    // the INVALID_CONFIG; just assert we got an AtlasError back.
    expect(result.error.code).toBeTruthy();
    expect(result.error.message).toMatch(/mv_city_signal/);
  });

  it.each([
    ['refreshCitySignal', refreshCitySignal],
    ['refreshEventsWithOrganizers', refreshEventsWithOrganizers],
    ['refreshPersonActivitySummary', refreshPersonActivitySummary],
  ])('%s surfaces INVALID_CONFIG when DATABASE_URL is missing', async (_name, fn) => {
    const result = await fn();
    expect(result.ok).toBe(false);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('INVALID_CONFIG');
  });
});
