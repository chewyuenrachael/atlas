-- =============================================================================
-- Cursor Community Atlas — migration 0003_fix_city_coordinate_matching
-- =============================================================================
-- Bug fix: Phase 1D Luma events store ISO 3166-1 alpha-2 country codes (AU,
-- US, CA, …) while city_coordinates from 0002 used English full names
-- (Australia, United States). The exact LOWER(city)/LOWER(country) join in
-- mv_events_with_organizers and mv_city_signal therefore matched zero rows,
-- leaving latitude/longitude NULL and the cockpit map at "cities: 0 events: 0".
--
-- Fix: seed every distinct Phase 1D Luma (venue_city, venue_country) pair
-- into city_coordinates with WGS84 centroids, then recreate the two map-
-- facing materialized views so they pick up the new rows.
-- =============================================================================

INSERT INTO city_coordinates (city, country, latitude, longitude) VALUES
    ('Brisbane City', 'AU', -27.4698, 153.0259),
    ('Calgary', 'CA', 51.0447, -114.0719),
    ('Gent', 'BE', 51.0543, 3.7174),
    ('Glen Allen', 'US', 37.6659, -77.5064),
    ('Hải Châu', 'VN', 16.0544, 108.2022),
    ('Helsinki', 'FI', 60.1699, 24.9384),
    ('Kisumu', 'KE', -0.1022, 34.7617),
    ('Lisboa', 'PT', 38.7223, -9.1393),
    ('Melbourne', 'AU', -37.8136, 144.9631),
    ('Nanakramguda', 'IN', 17.4199, 78.3682),
    ('Novi Sad', 'RS', 45.2671, 19.8335),
    ('Philadelphia', 'US', 39.9526, -75.1652),
    ('San Salvador', 'SV', 13.6929, -89.2182),
    ('Santa Cruz de la Sierra', 'BO', -17.7833, -63.1821),
    ('Stuttgart', 'DE', 48.7758, 9.1829),
    ('Tulcán', 'EC', 0.8117, -77.7172),
    ('Utrecht', 'NL', 52.0907, 5.1214),
    ('Wien', 'AT', 48.2082, 16.3738)
ON CONFLICT (city, country) DO NOTHING;

-- Recreate mv_city_signal (same definition as 0002, picks up new coordinates).
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

CREATE UNIQUE INDEX idx_mv_city_signal_pk
    ON mv_city_signal(location_city, COALESCE(location_country, ''));
CREATE INDEX idx_mv_city_signal_country
    ON mv_city_signal(location_country);
CREATE INDEX idx_mv_city_signal_total_people
    ON mv_city_signal(total_known_people DESC);

-- Recreate mv_events_with_organizers (same definition as 0002).
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
