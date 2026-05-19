/**
 * Phase 1D demo cockpit page.
 *
 * Server component that reads directly from Supabase via `@atlas/db` and
 * surfaces:
 *   - Total counts (events, persons, companies)
 *   - 10 most recent events with organizer, city, and date
 *   - 10 ambassadors by activity_score
 *
 * Deliberately plain HTML / Tailwind — the goal here is "shows real Luma
 * data" (Phase 1D exit criterion 4), not visual polish. Phase 3 lands the
 * map view + drill-downs.
 */
import { getServiceClient, type SupabaseClient } from '@atlas/db';
import type { Event as AtlasEvent, Person } from '@atlas/core';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Counts {
  events: number;
  persons: number;
  companies: number;
}

interface EventRow {
  id: string;
  title: string;
  starts_at: string;
  venue_city: string | null;
  venue_country: string | null;
  organizers: string[];
}

async function countRows(sb: SupabaseClient, table: string): Promise<number> {
  const r = await sb.from(table).select('id', { count: 'exact', head: true });
  if (r.error) return 0;
  return r.count ?? 0;
}

async function loadCounts(sb: SupabaseClient): Promise<Counts> {
  const [events, persons, companies] = await Promise.all([
    countRows(sb, 'event'),
    countRows(sb, 'person'),
    countRows(sb, 'company'),
  ]);
  return { events, persons, companies };
}

async function loadRecentEvents(sb: SupabaseClient): Promise<EventRow[]> {
  const events = await sb
    .from('event')
    .select('id, title, starts_at, venue_city, venue_country')
    .order('starts_at', { ascending: false })
    .limit(10);
  if (events.error || !events.data) return [];
  const rows = events.data as Pick<
    AtlasEvent,
    'id' | 'title' | 'starts_at' | 'venue_city' | 'venue_country'
  >[];

  // One round-trip per event to fetch organizers. Phase 3 collapses this
  // into a single materialized view (SPEC.md §6.4); for Phase 1D the N+1
  // is acceptable — N is at most 10.
  const enriched: EventRow[] = [];
  for (const row of rows) {
    const orgs = await sb
      .from('person_event')
      .select('person:person(canonical_name)')
      .eq('event_id', row.id)
      .in('role', ['organizer', 'co_organizer']);
    type OrgRow = { person: { canonical_name: string } | { canonical_name: string }[] | null };
    const data = (orgs.data ?? []) as OrgRow[];
    const names: string[] = [];
    for (const o of data) {
      const p = Array.isArray(o.person) ? o.person[0] : o.person;
      if (p?.canonical_name) names.push(p.canonical_name);
    }
    enriched.push({
      id: row.id,
      title: row.title,
      starts_at: row.starts_at,
      venue_city: row.venue_city,
      venue_country: row.venue_country,
      organizers: names,
    });
  }
  return enriched;
}

async function loadTopPersons(sb: SupabaseClient): Promise<Person[]> {
  const r = await sb
    .from('person')
    .select('*')
    .eq('is_active', true)
    .order('activity_score', { ascending: false })
    .order('last_observed_at', { ascending: false })
    .limit(10);
  if (r.error || !r.data) return [];
  return r.data as Person[];
}

function formatDate(iso: string): string {
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

export default async function HomePage() {
  const clientResult = getServiceClient();
  if (!clientResult.ok) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="text-2xl font-semibold">Cursor Community Atlas — Phase 1</h1>
        <p className="mt-4 rounded border border-red-700 bg-red-950/40 p-4 text-sm text-red-200">
          Database not configured: {clientResult.error.message}
        </p>
      </main>
    );
  }
  const sb = clientResult.value;
  const [counts, events, persons] = await Promise.all([
    loadCounts(sb),
    loadRecentEvents(sb),
    loadTopPersons(sb),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 text-sm">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
          cursor / community / atlas
        </p>
        <h1 className="mt-2 text-3xl font-semibold">
          Cursor Community Atlas — Phase 1 demo
        </h1>
        <p className="mt-2 max-w-2xl text-neutral-400">
          Live data read directly from Supabase. Phase 1 ingested the Luma{' '}
          <code className="rounded bg-neutral-800 px-1 py-0.5">cursorcommunity</code> event
          graph; Phase 2 wires the remaining six sources.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">
          totals
        </h2>
        <table className="w-full border border-neutral-800">
          <thead>
            <tr className="bg-neutral-900 text-left text-neutral-400">
              <th className="border-b border-neutral-800 px-4 py-2">Entity</th>
              <th className="border-b border-neutral-800 px-4 py-2 text-right">Count</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border-b border-neutral-800 px-4 py-2">events</td>
              <td className="border-b border-neutral-800 px-4 py-2 text-right font-mono">
                {counts.events}
              </td>
            </tr>
            <tr>
              <td className="border-b border-neutral-800 px-4 py-2">persons</td>
              <td className="border-b border-neutral-800 px-4 py-2 text-right font-mono">
                {counts.persons}
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2">companies</td>
              <td className="px-4 py-2 text-right font-mono">{counts.companies}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">
          10 most recent events
        </h2>
        {events.length === 0 ? (
          <p className="rounded border border-neutral-800 bg-neutral-900 p-4 text-neutral-400">
            No events ingested yet. Run <code>pnpm backfill:luma</code> to populate.
          </p>
        ) : (
          <table className="w-full border border-neutral-800">
            <thead>
              <tr className="bg-neutral-900 text-left text-neutral-400">
                <th className="border-b border-neutral-800 px-4 py-2">Date</th>
                <th className="border-b border-neutral-800 px-4 py-2">Event</th>
                <th className="border-b border-neutral-800 px-4 py-2">Location</th>
                <th className="border-b border-neutral-800 px-4 py-2">Organizers</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="border-b border-neutral-800 px-4 py-2 font-mono text-neutral-300">
                    {formatDate(e.starts_at)}
                  </td>
                  <td className="border-b border-neutral-800 px-4 py-2 text-neutral-100">
                    {e.title}
                  </td>
                  <td className="border-b border-neutral-800 px-4 py-2 text-neutral-300">
                    {formatLocation(e.venue_city, e.venue_country)}
                  </td>
                  <td className="border-b border-neutral-800 px-4 py-2 text-neutral-300">
                    {e.organizers.length > 0 ? e.organizers.join(', ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">
          top 10 ambassadors by activity_score
        </h2>
        {persons.length === 0 ? (
          <p className="rounded border border-neutral-800 bg-neutral-900 p-4 text-neutral-400">
            No persons ingested yet.
          </p>
        ) : (
          <table className="w-full border border-neutral-800">
            <thead>
              <tr className="bg-neutral-900 text-left text-neutral-400">
                <th className="border-b border-neutral-800 px-4 py-2">Name</th>
                <th className="border-b border-neutral-800 px-4 py-2">City</th>
                <th className="border-b border-neutral-800 px-4 py-2">Lifecycle</th>
                <th className="border-b border-neutral-800 px-4 py-2 text-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {persons.map((p) => (
                <tr key={p.id}>
                  <td className="border-b border-neutral-800 px-4 py-2 text-neutral-100">
                    {p.canonical_name}
                  </td>
                  <td className="border-b border-neutral-800 px-4 py-2 text-neutral-300">
                    {formatLocation(p.location_city, p.location_country)}
                  </td>
                  <td className="border-b border-neutral-800 px-4 py-2 font-mono text-neutral-300">
                    {p.lifecycle_stage ?? '—'}
                  </td>
                  <td className="border-b border-neutral-800 px-4 py-2 text-right font-mono">
                    {p.activity_score.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="mt-12 border-t border-neutral-900 pt-6 text-xs text-neutral-500">
        Phase 1 complete. Phase 2: add Twitter, GitHub, Reddit, HN, Cursor Forum, YouTube,
        LinkedIn. See <code>SPEC.md</code> §11.
      </footer>
    </main>
  );
}
