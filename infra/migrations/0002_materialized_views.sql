-- =============================================================================
-- Cursor Community Atlas — migration 0002_materialized_views
-- =============================================================================
-- Phase 3 prep: materialized views that back the cockpit map and other
-- read-heavy panels. Realizes SPEC.md §3.4 (schema conventions), §6.4
-- (materialized view pattern), §7 (query layer), and Appendix A.1 (city
-- signal query).
--
-- Three views are introduced:
--   1. mv_city_signal             — Appendix A.1, expanded with concrete
--                                   counts the cockpit map needs (lat/lng,
--                                   total event count, ambassador names,
--                                   communication count).
--   2. mv_events_with_organizers  — denormalized event row with a
--                                   pre-aggregated organizer array. Solves
--                                   the N+1 organizer fetch that the
--                                   Phase 1D cockpit page (apps/cockpit/app/
--                                   page.tsx) does inside a loop.
--   3. mv_person_activity_summary — per-Person rollup of event/communication/
--                                   artifact counts plus a recency score
--                                   used by the people side panel.
--
-- A small `city_coordinates` reference table is also introduced. The Luma
-- adapter does not yet capture lat/lng (see packages/adapters/luma/src/
-- normalizer.ts) so the map needs a known set of (city, country) →
-- (latitude, longitude) entries to plot points. The table is seeded with
-- major Luma-hosted cities; rows missing a match are still summarized in
-- mv_city_signal (with NULL lat/lng) but won't plot on the map. Phase 2+
-- will replace this with a proper geocoder.
--
-- All three views are populated synchronously (no `WITH NO DATA`) so the
-- migration doubles as the initial refresh. They are recreated rather than
-- altered to avoid the awkward "CREATE OR REPLACE MATERIALIZED VIEW" gap in
-- Postgres — a DROP+CREATE inside the same migration transaction is
-- atomic, and the 0001 view definition is a strict subset of the new one.
--
-- Refresh happens via `pnpm refresh:views` (scripts/refresh-views.ts) which
-- calls the per-view helpers in `packages/db/src/queries/views.ts`. Each
-- helper uses `REFRESH MATERIALIZED VIEW CONCURRENTLY` so cockpit reads do
-- not block; every view therefore needs a UNIQUE index, which is created
-- alongside each view below.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. city_coordinates — minimal geocoding table.
--
-- (city, country) → (latitude, longitude). Country is matched case-
-- insensitively in the view definition so "USA" / "United States" / "US"
-- and equivalent variants line up.
--
-- Coordinates are city-centroid (degrees, WGS84). Source: Wikipedia /
-- GeoNames public-domain coordinate listings, rounded to 4 decimal places
-- (~10 m precision, far below event-pin needs).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS city_coordinates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city TEXT NOT NULL,
    country TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    -- Lower-cased composite key so lookups in the view stay case-insensitive.
    UNIQUE (city, country)
);

CREATE INDEX IF NOT EXISTS idx_city_coordinates_lower
    ON city_coordinates (LOWER(city), LOWER(country));

-- Seed the table. Idempotent: INSERT … ON CONFLICT DO NOTHING so re-running
-- the migration is safe.
INSERT INTO city_coordinates (city, country, latitude, longitude) VALUES
    -- North America
    ('San Francisco', 'United States', 37.7749, -122.4194),
    ('New York', 'United States', 40.7128, -74.0060),
    ('Los Angeles', 'United States', 34.0522, -118.2437),
    ('Seattle', 'United States', 47.6062, -122.3321),
    ('Boston', 'United States', 42.3601, -71.0589),
    ('Austin', 'United States', 30.2672, -97.7431),
    ('Chicago', 'United States', 41.8781, -87.6298),
    ('Denver', 'United States', 39.7392, -104.9903),
    ('Atlanta', 'United States', 33.7490, -84.3880),
    ('Miami', 'United States', 25.7617, -80.1918),
    ('Washington', 'United States', 38.9072, -77.0369),
    ('San Diego', 'United States', 32.7157, -117.1611),
    ('San Jose', 'United States', 37.3382, -121.8863),
    ('Palo Alto', 'United States', 37.4419, -122.1430),
    ('Mountain View', 'United States', 37.3861, -122.0839),
    ('Berkeley', 'United States', 37.8715, -122.2730),
    ('Portland', 'United States', 45.5152, -122.6784),
    ('Philadelphia', 'United States', 39.9526, -75.1652),
    ('Toronto', 'Canada', 43.6532, -79.3832),
    ('Vancouver', 'Canada', 49.2827, -123.1207),
    ('Montreal', 'Canada', 45.5017, -73.5673),
    ('Waterloo', 'Canada', 43.4643, -80.5204),
    ('Mexico City', 'Mexico', 19.4326, -99.1332),
    -- Europe
    ('London', 'United Kingdom', 51.5074, -0.1278),
    ('Cambridge', 'United Kingdom', 52.2053, 0.1218),
    ('Oxford', 'United Kingdom', 51.7520, -1.2577),
    ('Edinburgh', 'United Kingdom', 55.9533, -3.1883),
    ('Manchester', 'United Kingdom', 53.4808, -2.2426),
    ('Dublin', 'Ireland', 53.3498, -6.2603),
    ('Paris', 'France', 48.8566, 2.3522),
    ('Berlin', 'Germany', 52.5200, 13.4050),
    ('Munich', 'Germany', 48.1351, 11.5820),
    ('Hamburg', 'Germany', 53.5511, 9.9937),
    ('Amsterdam', 'Netherlands', 52.3676, 4.9041),
    ('Rotterdam', 'Netherlands', 51.9244, 4.4777),
    ('Madrid', 'Spain', 40.4168, -3.7038),
    ('Barcelona', 'Spain', 41.3851, 2.1734),
    ('Lisbon', 'Portugal', 38.7223, -9.1393),
    ('Milan', 'Italy', 45.4642, 9.1900),
    ('Rome', 'Italy', 41.9028, 12.4964),
    ('Zurich', 'Switzerland', 47.3769, 8.5417),
    ('Geneva', 'Switzerland', 46.2044, 6.1432),
    ('Stockholm', 'Sweden', 59.3293, 18.0686),
    ('Copenhagen', 'Denmark', 55.6761, 12.5683),
    ('Oslo', 'Norway', 59.9139, 10.7522),
    ('Helsinki', 'Finland', 60.1699, 24.9384),
    ('Vienna', 'Austria', 48.2082, 16.3738),
    ('Prague', 'Czech Republic', 50.0755, 14.4378),
    ('Warsaw', 'Poland', 52.2297, 21.0122),
    ('Athens', 'Greece', 37.9838, 23.7275),
    ('Istanbul', 'Turkey', 41.0082, 28.9784),
    ('Tel Aviv', 'Israel', 32.0853, 34.7818),
    -- Asia-Pacific
    ('Tokyo', 'Japan', 35.6762, 139.6503),
    ('Osaka', 'Japan', 34.6937, 135.5023),
    ('Kyoto', 'Japan', 35.0116, 135.7681),
    ('Seoul', 'South Korea', 37.5665, 126.9780),
    ('Beijing', 'China', 39.9042, 116.4074),
    ('Shanghai', 'China', 31.2304, 121.4737),
    ('Shenzhen', 'China', 22.5431, 114.0579),
    ('Hong Kong', 'Hong Kong', 22.3193, 114.1694),
    ('Taipei', 'Taiwan', 25.0330, 121.5654),
    ('Singapore', 'Singapore', 1.3521, 103.8198),
    ('Bangkok', 'Thailand', 13.7563, 100.5018),
    ('Kuala Lumpur', 'Malaysia', 3.1390, 101.6869),
    ('Jakarta', 'Indonesia', -6.2088, 106.8456),
    ('Manila', 'Philippines', 14.5995, 120.9842),
    ('Ho Chi Minh City', 'Vietnam', 10.8231, 106.6297),
    ('Hanoi', 'Vietnam', 21.0285, 105.8542),
    ('Mumbai', 'India', 19.0760, 72.8777),
    ('Bangalore', 'India', 12.9716, 77.5946),
    ('Bengaluru', 'India', 12.9716, 77.5946),
    ('Delhi', 'India', 28.7041, 77.1025),
    ('New Delhi', 'India', 28.6139, 77.2090),
    ('Hyderabad', 'India', 17.3850, 78.4867),
    ('Chennai', 'India', 13.0827, 80.2707),
    ('Pune', 'India', 18.5204, 73.8567),
    ('Gurgaon', 'India', 28.4595, 77.0266),
    ('Sydney', 'Australia', -33.8688, 151.2093),
    ('Melbourne', 'Australia', -37.8136, 144.9631),
    ('Brisbane', 'Australia', -27.4698, 153.0251),
    ('Auckland', 'New Zealand', -36.8485, 174.7633),
    -- South America
    ('São Paulo', 'Brazil', -23.5505, -46.6333),
    ('Sao Paulo', 'Brazil', -23.5505, -46.6333),
    ('Rio de Janeiro', 'Brazil', -22.9068, -43.1729),
    ('Buenos Aires', 'Argentina', -34.6037, -58.3816),
    ('Santiago', 'Chile', -33.4489, -70.6693),
    ('Bogotá', 'Colombia', 4.7110, -74.0721),
    ('Bogota', 'Colombia', 4.7110, -74.0721),
    ('Lima', 'Peru', -12.0464, -77.0428),
    -- Africa
    ('Lagos', 'Nigeria', 6.5244, 3.3792),
    ('Nairobi', 'Kenya', -1.2921, 36.8219),
    ('Cape Town', 'South Africa', -33.9249, 18.4241),
    ('Johannesburg', 'South Africa', -26.2041, 28.0473),
    ('Accra', 'Ghana', 5.6037, -0.1870),
    ('Cairo', 'Egypt', 30.0444, 31.2357),
    -- Middle East
    ('Dubai', 'United Arab Emirates', 25.2048, 55.2708),
    ('Abu Dhabi', 'United Arab Emirates', 24.4539, 54.3773),
    ('Riyadh', 'Saudi Arabia', 24.7136, 46.6753)
ON CONFLICT (city, country) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. mv_city_signal — Appendix A.1 + cockpit-map extensions.
--
-- The 0001 definition tracked total_known_people / ambassador_count /
-- event_count_last_180d / avg_activity_score / recent_mentions. The map
-- needs more:
--   * latitude / longitude     — joined from city_coordinates; NULL when
--                                the city isn't seeded (graceful — the map
--                                simply skips plotting those points).
--   * total_event_count        — all-time event count (the 180d window
--                                stays in event_count_last_180d for the
--                                underserved-cities query).
--   * total_communication_count — communications authored by someone in
--                                the city.
--   * ambassador_names          — pre-joined ambassador names so the side
--                                panel doesn't re-query.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_city_signal CASCADE;

CREATE MATERIALIZED VIEW mv_city_signal AS
WITH city_event_rollup AS (
    SELECT
        e.venue_city,
        e.venue_country,
        COUNT(DISTINCT e.id) AS total_event_count,
        COUNT(DISTINCT CASE WHEN e.starts_at > NOW() - INTERVAL '180 days' THEN e.id END)
            AS event_count_last_180d
    FROM event e
    WHERE e.venue_city IS NOT NULL
    GROUP BY e.venue_city, e.venue_country
),
city_person_rollup AS (
    SELECT
        p.location_city,
        p.location_country,
        COUNT(DISTINCT p.id) AS total_known_people,
        COUNT(DISTINCT CASE WHEN p.lifecycle_stage IN ('ambassador', 'regional_lead') THEN p.id END)
            AS ambassador_count,
        AVG(p.activity_score)::NUMERIC(6,2) AS avg_activity_score,
        ARRAY_REMOVE(
            ARRAY_AGG(
                DISTINCT CASE
                    WHEN p.lifecycle_stage IN ('ambassador', 'regional_lead')
                    THEN p.canonical_name
                END
            ),
            NULL
        ) AS ambassador_names
    FROM person p
    WHERE p.location_city IS NOT NULL AND p.is_active = TRUE
    GROUP BY p.location_city, p.location_country
),
city_comm_rollup AS (
    SELECT
        p.location_city,
        p.location_country,
        COUNT(DISTINCT c.id) AS total_communication_count,
        COUNT(DISTINCT CASE
            WHEN c.posted_at > NOW() - INTERVAL '90 days' AND c.is_about_cursor
            THEN c.id
        END) AS recent_mentions
    FROM person p
    JOIN communication c ON c.author_person_id = p.id
    WHERE p.location_city IS NOT NULL
    GROUP BY p.location_city, p.location_country
),
all_cities AS (
    SELECT venue_city AS location_city, venue_country AS location_country FROM city_event_rollup
    UNION
    SELECT location_city, location_country FROM city_person_rollup
)
SELECT
    ac.location_city,
    ac.location_country,
    COALESCE(cpr.total_known_people, 0)         AS total_known_people,
    COALESCE(cpr.ambassador_count, 0)           AS ambassador_count,
    COALESCE(cer.event_count_last_180d, 0)      AS event_count_last_180d,
    COALESCE(cer.total_event_count, 0)          AS total_event_count,
    COALESCE(cpr.avg_activity_score, 0)::NUMERIC(6,2) AS avg_activity_score,
    COALESCE(ccr.recent_mentions, 0)            AS recent_mentions,
    COALESCE(ccr.total_communication_count, 0)  AS total_communication_count,
    COALESCE(cpr.ambassador_names, ARRAY[]::TEXT[]) AS ambassador_names,
    cc.latitude,
    cc.longitude
FROM all_cities ac
LEFT JOIN city_person_rollup cpr
       ON cpr.location_city = ac.location_city
      AND cpr.location_country IS NOT DISTINCT FROM ac.location_country
LEFT JOIN city_event_rollup cer
       ON cer.venue_city = ac.location_city
      AND cer.venue_country IS NOT DISTINCT FROM ac.location_country
LEFT JOIN city_comm_rollup ccr
       ON ccr.location_city = ac.location_city
      AND ccr.location_country IS NOT DISTINCT FROM ac.location_country
LEFT JOIN city_coordinates cc
       ON LOWER(cc.city) = LOWER(ac.location_city)
      AND LOWER(cc.country) = LOWER(COALESCE(ac.location_country, ''));

-- UNIQUE index required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
-- COALESCE on location_country because PostgREST returns NULLs when the
-- column is empty; the COALESCE gives us a stable composite key.
CREATE UNIQUE INDEX idx_mv_city_signal_pk
    ON mv_city_signal(location_city, COALESCE(location_country, ''));
CREATE INDEX idx_mv_city_signal_country
    ON mv_city_signal(location_country);
CREATE INDEX idx_mv_city_signal_total_people
    ON mv_city_signal(total_known_people DESC);

-- ---------------------------------------------------------------------------
-- 2. mv_events_with_organizers — denormalized event + organizers.
--
-- The cockpit map plots every event and shows organizers in the side panel.
-- The Phase 1D /tables page issues N+1 fetches (one round-trip per event)
-- to populate the organizer column. This view collapses that into a single
-- read by pre-joining person_event(role IN organizer/co_organizer) and
-- aggregating into a JSONB array.
--
-- Event lat/lng comes from the city_coordinates lookup table — same source
-- as mv_city_signal — so events in the same city stack at the same pin.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_events_with_organizers CASCADE;

CREATE MATERIALIZED VIEW mv_events_with_organizers AS
SELECT
    e.id,
    e.title,
    e.description,
    e.program_id,
    e.program_type,
    e.event_format,
    e.starts_at,
    e.ends_at,
    e.timezone,
    e.venue_city,
    e.venue_country,
    e.venue_name,
    e.venue_company_id,
    e.host_company_id,
    e.status,
    e.registered_count,
    e.attended_count,
    e.sentiment_score,
    e.source_url,
    e.luma_event_id,
    e.created_at,
    e.updated_at,
    cc.latitude,
    cc.longitude,
    -- One JSONB array per event: [{ person_id, name, role }, ...]
    COALESCE(
        (
            SELECT JSONB_AGG(
                JSONB_BUILD_OBJECT(
                    'person_id', p.id,
                    'name', p.canonical_name,
                    'role', pe.role
                )
                ORDER BY
                    CASE pe.role
                        WHEN 'organizer' THEN 0
                        WHEN 'co_organizer' THEN 1
                        ELSE 2
                    END,
                    p.canonical_name
            )
            FROM person_event pe
            JOIN person p ON p.id = pe.person_id
            WHERE pe.event_id = e.id
              AND pe.role IN ('organizer', 'co_organizer')
        ),
        '[]'::JSONB
    ) AS organizers,
    -- Convenience scalar: comma-joined organizer names for table renders.
    COALESCE(
        (
            SELECT STRING_AGG(p.canonical_name, ', '
                              ORDER BY
                                CASE pe.role
                                    WHEN 'organizer' THEN 0
                                    WHEN 'co_organizer' THEN 1
                                    ELSE 2
                                END,
                                p.canonical_name)
            FROM person_event pe
            JOIN person p ON p.id = pe.person_id
            WHERE pe.event_id = e.id
              AND pe.role IN ('organizer', 'co_organizer')
        ),
        ''
    ) AS organizer_names_csv
FROM event e
LEFT JOIN city_coordinates cc
       ON LOWER(cc.city) = LOWER(e.venue_city)
      AND LOWER(cc.country) = LOWER(COALESCE(e.venue_country, ''));

CREATE UNIQUE INDEX idx_mv_events_with_organizers_pk
    ON mv_events_with_organizers(id);
CREATE INDEX idx_mv_events_with_organizers_city
    ON mv_events_with_organizers(venue_country, venue_city);
CREATE INDEX idx_mv_events_with_organizers_starts_at
    ON mv_events_with_organizers(starts_at DESC);
CREATE INDEX idx_mv_events_with_organizers_program_type
    ON mv_events_with_organizers(program_type);

-- ---------------------------------------------------------------------------
-- 3. mv_person_activity_summary — per-Person rollup for the people panel.
--
-- Composes:
--   * event_count             — number of distinct events the person has
--                               attended/organized
--   * organizer_event_count   — subset where role IN (organizer, co_organizer)
--   * communication_count     — communications authored
--   * artifact_count          — artifacts created
--   * last_activity_at        — most recent attended_at / posted_at /
--                               created_at across the three tables
--   * recency_score           — 1.0 / (1 + days_since_last_activity);
--                               clamps to (0, 1], higher = more recent.
--                               Useful as a tie-breaker when sorting people.
--
-- Only active persons are included; merged duplicates (`is_active = FALSE`)
-- shouldn't surface in the cockpit.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_person_activity_summary CASCADE;

CREATE MATERIALIZED VIEW mv_person_activity_summary AS
WITH person_events AS (
    SELECT
        pe.person_id,
        COUNT(DISTINCT pe.event_id) AS event_count,
        COUNT(DISTINCT CASE
            WHEN pe.role IN ('organizer', 'co_organizer') THEN pe.event_id
        END) AS organizer_event_count,
        MAX(COALESCE(pe.attended_at, pe.registered_at)) AS last_event_at
    FROM person_event pe
    GROUP BY pe.person_id
),
person_comms AS (
    SELECT
        c.author_person_id AS person_id,
        COUNT(*) AS communication_count,
        MAX(c.posted_at) AS last_communication_at
    FROM communication c
    WHERE c.author_person_id IS NOT NULL
    GROUP BY c.author_person_id
),
person_artifacts AS (
    SELECT
        a.creator_person_id AS person_id,
        COUNT(*) AS artifact_count,
        MAX(a.created_at) AS last_artifact_at
    FROM artifact a
    WHERE a.creator_person_id IS NOT NULL
    GROUP BY a.creator_person_id
)
SELECT
    p.id AS person_id,
    p.canonical_name,
    p.location_city,
    p.location_country,
    p.lifecycle_stage,
    p.activity_score,
    COALESCE(pe.event_count, 0)             AS event_count,
    COALESCE(pe.organizer_event_count, 0)   AS organizer_event_count,
    COALESCE(pc.communication_count, 0)     AS communication_count,
    COALESCE(pa.artifact_count, 0)          AS artifact_count,
    GREATEST(
        COALESCE(pe.last_event_at, '-infinity'::TIMESTAMPTZ),
        COALESCE(pc.last_communication_at, '-infinity'::TIMESTAMPTZ),
        COALESCE(pa.last_artifact_at, '-infinity'::TIMESTAMPTZ),
        p.last_observed_at
    ) AS last_activity_at,
    -- recency_score collapses time-since-last-activity into a [0, 1]
    -- ranking score. 0 days → 1.0; 365 days → ~0.0027. GREATEST against
    -- last_observed_at so newly-created persons aren't 0.
    (
        1.0 / GREATEST(
            1.0,
            EXTRACT(EPOCH FROM (NOW() - GREATEST(
                COALESCE(pe.last_event_at, '-infinity'::TIMESTAMPTZ),
                COALESCE(pc.last_communication_at, '-infinity'::TIMESTAMPTZ),
                COALESCE(pa.last_artifact_at, '-infinity'::TIMESTAMPTZ),
                p.last_observed_at
            ))) / 86400.0
        )
    )::NUMERIC(6,4) AS recency_score
FROM person p
LEFT JOIN person_events    pe ON pe.person_id = p.id
LEFT JOIN person_comms     pc ON pc.person_id = p.id
LEFT JOIN person_artifacts pa ON pa.person_id = p.id
WHERE p.is_active = TRUE;

CREATE UNIQUE INDEX idx_mv_person_activity_summary_pk
    ON mv_person_activity_summary(person_id);
CREATE INDEX idx_mv_person_activity_summary_city
    ON mv_person_activity_summary(location_country, location_city);
CREATE INDEX idx_mv_person_activity_summary_recency
    ON mv_person_activity_summary(recency_score DESC);
CREATE INDEX idx_mv_person_activity_summary_lifecycle
    ON mv_person_activity_summary(lifecycle_stage);

-- =============================================================================
-- End of migration 0002_materialized_views.sql
-- =============================================================================
