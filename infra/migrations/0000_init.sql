-- =============================================================================
-- Cursor Community Atlas — migration 0000_init
-- =============================================================================
-- This is a placeholder. Phase 1 fills in the actual schema (entities, edges,
-- raw tables, audit log, materialized views) per SPEC.md §3.
--
-- Migration conventions:
--   * One file per migration, filename pattern: NNNN_kebab_case_description.sql
--   * NNNN is a 4-digit zero-padded integer monotonically increasing from 0000
--   * Each file is idempotent where possible (CREATE TABLE IF NOT EXISTS,
--     CREATE INDEX IF NOT EXISTS, etc) so that re-running is safe
--   * No DROP statements without an accompanying down-migration plan
--   * All schema enums use TEXT + CHECK constraint (SPEC.md §3.4 #3)
--   * All primary keys are UUID with `gen_random_uuid()` default
--   * All timestamps are TIMESTAMPTZ stored UTC (SPEC.md §3.4 #2)
--   * Migrations run in a single transaction. If you need DDL that cannot run
--     inside a transaction (e.g. CONCURRENTLY index creation), split into a
--     separate file with a comment explaining why.
--
-- Apply migrations via the Supabase dashboard SQL editor (Phase 0) or the
-- Supabase CLI (`supabase db push`) once the project is provisioned.
-- =============================================================================

-- Phase 0: intentionally empty. See SPEC.md §11 Phase 1 for the first real
-- migration content.

SELECT 1;
