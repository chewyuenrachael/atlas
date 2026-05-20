'use client';

/**
 * Interactive cockpit map.
 *
 * Client component — owns the Mapbox GL instance, marker layers, and the
 * side panel state. Data is shipped from the server component as plain
 * JSON; this file never touches the database.
 *
 * Map layers (built as Mapbox circle layers off GeoJSON sources so we get
 * native click handling and zoom-dependent sizing without DOM markers):
 *
 *   - "events"           One circle per event in mv_events_with_organizers.
 *                        Color encodes program_type.
 *   - "cities"           One circle per ambassador city (mv_city_signal,
 *                        ambassador_count > 0). Radius scales with the
 *                        city's total event count.
 *
 * Interactions:
 *   - Click an event circle  → side panel: event details + organizers.
 *   - Click a city circle    → side panel: events + ambassadors there.
 *
 * SPEC.md §6.4 / §7. Phase 3 task brief.
 */
import 'mapbox-gl/dist/mapbox-gl.css';
import mapboxgl, { type GeoJSONSource, type MapMouseEvent } from 'mapbox-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CitySignalRow, EventOrganizerEntry, EventWithOrganizersRow } from '@atlas/db';

// ---------------------------------------------------------------------------
// Color mapping for event program types. Kept short and high-contrast so
// markers stay legible at z=2. Tailwind palette tokens for parity with the
// rest of the cockpit.
// ---------------------------------------------------------------------------
const PROGRAM_TYPE_COLORS: Record<string, { color: string; label: string }> = {
  cafe_cursor: { color: '#60a5fa', label: 'Café Cursor' },
  hackathon: { color: '#a78bfa', label: 'Hackathon' },
  workshop: { color: '#34d399', label: 'Workshop' },
  meetup: { color: '#fb923c', label: 'Meetup' },
  vertical_finance: { color: '#f87171', label: 'Vertical: Finance' },
  vertical_healthcare: { color: '#f472b6', label: 'Vertical: Healthcare' },
  vertical_defense: { color: '#fbbf24', label: 'Vertical: Defense' },
  campus: { color: '#facc15', label: 'Campus' },
  ambassador_internal: { color: '#22d3ee', label: 'Ambassador internal' },
  other: { color: '#94a3b8', label: 'Other' },
};
const UNCATEGORIZED_COLOR = '#737373';

function colorForProgramType(programType: string | null | undefined): string {
  if (!programType) return UNCATEGORIZED_COLOR;
  return PROGRAM_TYPE_COLORS[programType]?.color ?? UNCATEGORIZED_COLOR;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface MapViewProps {
  mapboxToken: string;
  /** Cities to plot as ambassador-city pins. */
  cities: CitySignalRow[];
  /**
   * Every city signal row (with coordinates) returned by the view. Used by
   * the city side panel to look up ambassador / event totals even for the
   * city the user clicked through to from an event pin.
   */
  allCitySignals: CitySignalRow[];
  /** Events to plot as event pins. */
  events: EventWithOrganizersRow[];
}

type Selection =
  | { kind: 'event'; eventId: string }
  | { kind: 'city'; city: string; country: string | null }
  | null;

// ---------------------------------------------------------------------------
// GeoJSON helpers. Mapbox sources accept GeoJSON FeatureCollections; we
// memoize these so the source's setData isn't called on every render.
// ---------------------------------------------------------------------------
interface EventFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    id: string;
    title: string;
    program_type: string | null;
    color: string;
    venue_city: string | null;
    venue_country: string | null;
  };
}
interface CityFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    city: string;
    country: string | null;
    total_event_count: number;
    ambassador_count: number;
    total_known_people: number;
  };
}
interface FeatureCollection<F> {
  type: 'FeatureCollection';
  features: F[];
}

function buildEventFeatures(events: EventWithOrganizersRow[]): FeatureCollection<EventFeature> {
  return {
    type: 'FeatureCollection',
    features: events
      .filter((e) => e.latitude !== null && e.longitude !== null)
      .map<EventFeature>((e) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          // Mapbox uses [lng, lat] order.
          coordinates: [e.longitude as number, e.latitude as number],
        },
        properties: {
          id: e.id,
          title: e.title,
          program_type: e.program_type,
          color: colorForProgramType(e.program_type),
          venue_city: e.venue_city,
          venue_country: e.venue_country,
        },
      })),
  };
}

function buildCityFeatures(cities: CitySignalRow[]): FeatureCollection<CityFeature> {
  return {
    type: 'FeatureCollection',
    features: cities
      .filter((c) => c.latitude !== null && c.longitude !== null)
      .map<CityFeature>((c) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [c.longitude as number, c.latitude as number],
        },
        properties: {
          city: c.location_city,
          country: c.location_country,
          total_event_count: c.total_event_count,
          ambassador_count: c.ambassador_count,
          total_known_people: c.total_known_people,
        },
      })),
  };
}

// ---------------------------------------------------------------------------
// Side-panel rendering helpers. Kept as plain functions to keep the
// component file readable; they're pure and don't touch the map.
// ---------------------------------------------------------------------------
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function formatLocation(city: string | null, country: string | null): string {
  if (city && country) return `${city}, ${country}`;
  return city ?? country ?? '—';
}

// ---------------------------------------------------------------------------
// MapView component
// ---------------------------------------------------------------------------
export function MapView({ mapboxToken, cities, allCitySignals, events }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [mapReady, setMapReady] = useState<boolean>(false);

  // Stable references so the data-binding effect doesn't churn every render.
  const eventFeatures = useMemo(() => buildEventFeatures(events), [events]);
  const cityFeatures = useMemo(() => buildCityFeatures(cities), [cities]);

  // Convenience lookups for the side panel.
  const eventsById = useMemo(() => {
    const m = new Map<string, EventWithOrganizersRow>();
    for (const e of events) m.set(e.id, e);
    return m;
  }, [events]);
  const citySignalLookup = useMemo(() => {
    const m = new Map<string, CitySignalRow>();
    for (const c of allCitySignals) {
      m.set(`${c.location_city}|${c.location_country ?? ''}`, c);
    }
    return m;
  }, [allCitySignals]);

  // -------------------------------------------------------------------------
  // Map lifecycle: create on mount, destroy on unmount.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!mapboxToken || mapboxToken.length === 0) return;
    if (containerRef.current === null) return;

    mapboxgl.accessToken = mapboxToken;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [10, 25],
      zoom: 1.5,
      attributionControl: true,
      cooperativeGestures: false,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-right');

    map.on('load', () => {
      // City layer (renders below events so event pins sit on top).
      map.addSource('cities', { type: 'geojson', data: cityFeatures });
      map.addLayer({
        id: 'cities-circles',
        type: 'circle',
        source: 'cities',
        paint: {
          // Radius interpolates 6 → 24 across [0, 30] events in the city.
          'circle-radius': ['interpolate', ['linear'], ['get', 'total_event_count'], 0, 6, 30, 24],
          'circle-color': '#fbbf24',
          'circle-opacity': 0.35,
          'circle-stroke-color': '#fbbf24',
          'circle-stroke-width': 1.5,
          'circle-stroke-opacity': 0.9,
        },
      });

      // Event layer.
      map.addSource('events', { type: 'geojson', data: eventFeatures });
      map.addLayer({
        id: 'events-circles',
        type: 'circle',
        source: 'events',
        paint: {
          'circle-radius': 5,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#0a0a0a',
          'circle-stroke-width': 1,
        },
      });

      // Click handlers. Use queryRenderedFeatures so overlapping pins fall
      // through to the highest layer (events) first.
      const onClick = (e: MapMouseEvent) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ['events-circles', 'cities-circles'],
        });
        if (features.length === 0) {
          setSelection(null);
          return;
        }
        const f = features[0];
        if (!f) return;
        if (f.layer?.id === 'events-circles') {
          const id = f.properties?.['id'];
          if (typeof id === 'string') setSelection({ kind: 'event', eventId: id });
        } else if (f.layer?.id === 'cities-circles') {
          const city = f.properties?.['city'];
          const country = f.properties?.['country'] ?? null;
          if (typeof city === 'string') {
            setSelection({
              kind: 'city',
              city,
              country: typeof country === 'string' ? country : null,
            });
          }
        }
      };
      map.on('click', onClick);

      // Cursor affordance.
      for (const layerId of ['events-circles', 'cities-circles']) {
        map.on('mouseenter', layerId, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', layerId, () => (map.getCanvas().style.cursor = ''));
      }

      setMapReady(true);
    });

    return () => {
      mapRef.current = null;
      map.remove();
    };
    // eventFeatures/cityFeatures are deliberately not in the dep list — the
    // sources are bound at load time and then updated via setData in the
    // separate effect below. Re-running this effect when data changes would
    // destroy and rebuild the whole map.
  }, [mapboxToken]);

  // Update GeoJSON sources when data changes (e.g. on hot reload).
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const evSrc = map.getSource('events') as GeoJSONSource | undefined;
    const cySrc = map.getSource('cities') as GeoJSONSource | undefined;
    if (evSrc) evSrc.setData(eventFeatures);
    if (cySrc) cySrc.setData(cityFeatures);
  }, [mapReady, eventFeatures, cityFeatures]);

  // -------------------------------------------------------------------------
  // No token → render a hard error pane. Mapbox won't initialize without it.
  // -------------------------------------------------------------------------
  if (!mapboxToken) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-12 text-sm">
        <h1 className="text-2xl font-semibold">Map unavailable</h1>
        <p className="mt-4 rounded border border-amber-700 bg-amber-950/40 p-4 text-amber-200">
          <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> is not set. Add a Mapbox public token to{' '}
          <code>.env.local</code> in <code>apps/cockpit/</code> and restart <code>pnpm dev</code>.
        </p>
      </main>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="relative h-[calc(100vh-49px)] w-full">
      <div ref={containerRef} className="absolute inset-0" />
      <MapLegend />
      <MapStatusBadge cities={cities.length} events={events.length} />
      <SidePanel
        selection={selection}
        onClose={() => setSelection(null)}
        eventsById={eventsById}
        citySignalLookup={citySignalLookup}
        eventsByCity={(city, country) =>
          events.filter((e) => e.venue_city === city && (e.venue_country ?? null) === country)
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend, status badge, side panel — broken out for readability.
// ---------------------------------------------------------------------------

function MapLegend(): JSX.Element {
  return (
    <div className="absolute bottom-6 left-6 z-10 max-w-xs rounded border border-neutral-800 bg-neutral-950/90 p-3 text-xs text-neutral-200 shadow-lg backdrop-blur">
      <div className="mb-2 font-mono uppercase tracking-widest text-neutral-500">legend</div>
      <div className="mb-2">
        <div className="mb-1 text-neutral-400">Events (color = program type)</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(PROGRAM_TYPE_COLORS).map(([key, { color, label }]) => (
            <span key={key} className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="text-neutral-300">{label}</span>
            </span>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 text-neutral-400">Ambassador cities</div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-full border border-amber-400 bg-amber-400/30"
          />
          <span className="text-neutral-300">size = total events in city</span>
        </div>
      </div>
    </div>
  );
}

function MapStatusBadge({ cities, events }: { cities: number; events: number }): JSX.Element {
  return (
    <div className="absolute right-6 top-6 z-10 rounded border border-neutral-800 bg-neutral-950/90 px-3 py-2 text-xs text-neutral-300 shadow-lg backdrop-blur">
      <div>
        <span className="font-mono text-neutral-500">cities:</span>{' '}
        <span className="font-mono text-neutral-100">{cities}</span>
      </div>
      <div>
        <span className="font-mono text-neutral-500">events:</span>{' '}
        <span className="font-mono text-neutral-100">{events}</span>
      </div>
    </div>
  );
}

function SidePanel({
  selection,
  onClose,
  eventsById,
  citySignalLookup,
  eventsByCity,
}: {
  selection: Selection;
  onClose: () => void;
  eventsById: Map<string, EventWithOrganizersRow>;
  citySignalLookup: Map<string, CitySignalRow>;
  eventsByCity: (city: string, country: string | null) => EventWithOrganizersRow[];
}): JSX.Element | null {
  if (!selection) return null;

  return (
    <aside className="absolute right-0 top-0 z-20 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-neutral-800 bg-neutral-950/95 p-6 text-sm text-neutral-100 shadow-xl backdrop-blur">
      <div className="mb-4 flex items-start justify-between">
        <span className="font-mono text-xs uppercase tracking-widest text-neutral-500">
          {selection.kind === 'event' ? 'event detail' : 'city detail'}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close side panel"
          className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
        >
          close
        </button>
      </div>
      {selection.kind === 'event' ? (
        <EventDetail event={eventsById.get(selection.eventId)} />
      ) : (
        <CityDetail
          city={selection.city}
          country={selection.country}
          citySignal={citySignalLookup.get(`${selection.city}|${selection.country ?? ''}`) ?? null}
          events={eventsByCity(selection.city, selection.country)}
        />
      )}
    </aside>
  );
}

function EventDetail({ event }: { event: EventWithOrganizersRow | undefined }): JSX.Element {
  if (!event) {
    return <p className="text-neutral-400">Event not found in current dataset.</p>;
  }
  const colorMeta = event.program_type ? PROGRAM_TYPE_COLORS[event.program_type] : undefined;
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-neutral-50">{event.title}</h2>
        <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: colorForProgramType(event.program_type) }}
          />
          <span>{colorMeta?.label ?? event.program_type ?? 'Uncategorized'}</span>
          <span>·</span>
          <span className="font-mono">{formatDate(event.starts_at)}</span>
        </div>
      </header>

      <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
        <Stat label="Location" value={formatLocation(event.venue_city, event.venue_country)} />
        <Stat label="Format" value={event.event_format ?? '—'} />
        <Stat label="Status" value={event.status ?? '—'} />
        <Stat label="Registered" value={String(event.registered_count)} />
        <Stat label="Attended" value={String(event.attended_count)} />
        <Stat label="Venue" value={event.venue_name ?? '—'} />
      </dl>

      <section>
        <h3 className="mb-1 font-mono text-xs uppercase tracking-widest text-neutral-500">
          organizers
        </h3>
        {event.organizers.length === 0 ? (
          <p className="text-neutral-400">No organizer captured.</p>
        ) : (
          <ul className="space-y-1">
            {event.organizers.map((o: EventOrganizerEntry) => (
              <li key={o.person_id} className="flex items-baseline gap-2 text-neutral-100">
                <span className="text-neutral-100">{o.name}</span>
                <span className="font-mono text-xs text-neutral-500">{o.role}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {event.description ? (
        <section>
          <h3 className="mb-1 font-mono text-xs uppercase tracking-widest text-neutral-500">
            description
          </h3>
          <p className="whitespace-pre-wrap text-neutral-300">{event.description}</p>
        </section>
      ) : null}

      {event.source_url ? (
        <a
          href={event.source_url}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-xs text-blue-400 underline hover:text-blue-300"
        >
          Open in Luma →
        </a>
      ) : null}
    </div>
  );
}

function CityDetail({
  city,
  country,
  citySignal,
  events,
}: {
  city: string;
  country: string | null;
  citySignal: CitySignalRow | null;
  events: EventWithOrganizersRow[];
}): JSX.Element {
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-neutral-50">{formatLocation(city, country)}</h2>
        <p className="mt-1 text-xs text-neutral-500">
          From <code className="rounded bg-neutral-900 px-1 py-0.5">mv_city_signal</code>
        </p>
      </header>

      {citySignal ? (
        <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
          <Stat label="People" value={String(citySignal.total_known_people)} />
          <Stat label="Ambassadors" value={String(citySignal.ambassador_count)} />
          <Stat label="Avg activity" value={citySignal.avg_activity_score.toFixed(1)} />
          <Stat label="Events (all-time)" value={String(citySignal.total_event_count)} />
          <Stat label="Events (180d)" value={String(citySignal.event_count_last_180d)} />
          <Stat label="Mentions (90d)" value={String(citySignal.recent_mentions)} />
        </dl>
      ) : (
        <p className="text-neutral-400">City not present in mv_city_signal.</p>
      )}

      <section>
        <h3 className="mb-1 font-mono text-xs uppercase tracking-widest text-neutral-500">
          ambassadors
        </h3>
        {!citySignal || citySignal.ambassador_names.length === 0 ? (
          <p className="text-neutral-400">No ambassador captured.</p>
        ) : (
          <ul className="space-y-1">
            {citySignal.ambassador_names.map((name) => (
              <li key={name} className="text-neutral-100">
                {name}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-1 font-mono text-xs uppercase tracking-widest text-neutral-500">
          events here ({events.length})
        </h3>
        {events.length === 0 ? (
          <p className="text-neutral-400">No events in this city yet.</p>
        ) : (
          <ul className="space-y-1">
            {events
              .slice()
              .sort((a, b) => (a.starts_at < b.starts_at ? 1 : -1))
              .map((e) => (
                <li key={e.id} className="flex items-baseline gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: colorForProgramType(e.program_type) }}
                  />
                  <span className="font-mono text-xs text-neutral-500">
                    {formatDate(e.starts_at)}
                  </span>
                  <span className="text-neutral-100">{e.title}</span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt className="font-mono text-neutral-500">{label}</dt>
      <dd className="col-span-2 text-neutral-100">{value}</dd>
    </>
  );
}
