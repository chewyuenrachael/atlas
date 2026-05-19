-- =============================================================================
-- Cursor Community Atlas — migration 0001_create_raw_luma_event
-- =============================================================================
-- Creates the `raw_luma_event` raw-source table per SPEC.md §3.5. The Luma
-- adapter (packages/adapters/luma) writes one row per scraped event. The
-- normalizer reads these rows and produces canonical Event + Person records.
--
-- The `luma_event_id` UNIQUE constraint is the idempotency key for the
-- adapter (SPEC.md §5.4). Re-running `LumaAdapter.fetch()` produces zero
-- new rows when an event has already been ingested.
--
-- SPEC ref: §3.5 (raw source tables), §5.2.1 (Luma adapter spec).
-- =============================================================================

CREATE TABLE IF NOT EXISTS raw_luma_event (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    luma_event_id        TEXT         NOT NULL UNIQUE,
    raw_payload          JSONB        NOT NULL,
    payload_hash         TEXT         NOT NULL,
    source_url           TEXT,
    scraped_at           TIMESTAMPTZ  NOT NULL,
    ingested_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    normalized_at        TIMESTAMPTZ,
    normalization_status TEXT         CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')) DEFAULT 'pending',
    normalization_error  TEXT
);

CREATE INDEX IF NOT EXISTS idx_raw_luma_event_status
    ON raw_luma_event(normalization_status)
    WHERE normalization_status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_raw_luma_event_ingested
    ON raw_luma_event(ingested_at DESC);

-- The payload_hash lets the normalizer short-circuit when a re-scrape
-- produced identical detail content (SPEC.md §5.4 hash-based change
-- detection).
CREATE INDEX IF NOT EXISTS idx_raw_luma_event_payload_hash
    ON raw_luma_event(payload_hash);
