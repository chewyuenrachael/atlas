/**
 * Cockpit map view.
 *
 * Server component. Loads the data the map needs from the Phase 3
 * materialized views (mv_city_signal + mv_events_with_organizers) and
 * hands it off to the `<MapView>` client component which handles all the
 * interactive bits (pan, zoom, marker clicks, side panel).
 *
 * Filters applied here:
 *   - Cities:  ambassador_count > 0 AND latitude/longitude not null. The
 *              cockpit treats "ambassador city" as cities that have at
 *              least one ambassador (or regional lead) living there.
 *   - Events:  latitude/longitude not null. Events without a known venue
 *              city (or with a city missing from city_coordinates) are
 *              skipped on the map — they still appear at /tables.
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

  // Only plot cities that have at least one ambassador or regional lead.
  // The view returns ambassador_count = 0 cities too (still useful for
  // signal queries); we keep them out of the map's "ambassador city"
  // layer to match the brief.
  const ambassadorCities = citiesResult.value.filter((c) => c.ambassador_count > 0);
  const events = eventsResult.value;

  return (
    <MapView
      mapboxToken={mapboxToken}
      cities={ambassadorCities}
      allCitySignals={citiesResult.value}
      events={events}
    />
  );
}
