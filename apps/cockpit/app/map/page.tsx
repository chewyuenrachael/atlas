/**
 * Cockpit map view.
 *
 * Server component. Loads the data the map needs from the Phase 3
 * materialized views (mv_city_signal + mv_events_with_organizers) and
 * hands it off to the `<MapView>` client component which handles all the
 * interactive bits (pan, zoom, marker clicks, side panel).
 *
 * Filters applied here:
 *   - Cities:  total_event_count > 0 (or ambassador_count > 0 when present)
 *              AND latitude/longitude not null. Phase 1D Luma data has no
 *              lifecycle_stage=ambassador rows yet, so we plot every city
 *              that has hosted at least one event. Once ambassadors land,
 *              cities with ambassadors still qualify via the OR branch.
 *   - Events:  latitude/longitude not null. Events without a resolvable
 *              venue city are skipped on the map — they still appear at
 *              /tables.
 *
 * SPEC.md §7 (Query Layer), §6.4 (Materialized Views).
 */
import { ViewQueries } from '@atlas/db';
import { MapView } from './MapView';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function MapPage() {
  const mapboxToken = process.env['NEXT_PUBLIC_MAPBOX_TOKEN'] ?? '';

  const [citiesResult, eventsResult] = await Promise.all([
    ViewQueries.getCitySignalRows({ onlyWithCoordinates: true }),
    ViewQueries.getEventsWithOrganizers({ onlyWithCoordinates: true }),
  ]);

  if (!citiesResult.ok) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-12 text-sm">
        <h1 className="text-2xl font-semibold">Map unavailable</h1>
        <p className="mt-4 rounded border border-red-700 bg-red-950/40 p-4 text-red-200">
          Could not load mv_city_signal: {citiesResult.error.message}. Apply migration{' '}
          <code>0002_materialized_views.sql</code> and run <code>pnpm refresh:views</code>.
        </p>
      </main>
    );
  }
  if (!eventsResult.ok) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-12 text-sm">
        <h1 className="text-2xl font-semibold">Map unavailable</h1>
        <p className="mt-4 rounded border border-red-700 bg-red-950/40 p-4 text-red-200">
          Could not load mv_events_with_organizers: {eventsResult.error.message}. Apply migration{' '}
          <code>0002_materialized_views.sql</code> and run <code>pnpm refresh:views</code>.
        </p>
      </main>
    );
  }

  // Plot cities with community activity: hosted events and/or ambassadors.
  // Phase 1D has events but no ambassador lifecycle rows yet; requiring
  // ambassador_count > 0 alone would zero out the city layer.
  const mapCities = citiesResult.value.filter(
    (c) => c.total_event_count > 0 || c.ambassador_count > 0,
  );
  const events = eventsResult.value;

  return (
    <MapView
      mapboxToken={mapboxToken}
      cities={mapCities}
      allCitySignals={citiesResult.value}
      events={events}
    />
  );
}
