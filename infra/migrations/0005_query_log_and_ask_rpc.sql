-- Phase 3: Ask Anything support.
-- 1) query_log    — audit trail for every NL/SQL query the cockpit runs.
-- 2) atlas_run_select — RPC that executes a single SELECT under a
--    statement_timeout and result-row cap. Defense-in-depth:
--      a. service-role secret is server-only,
--      b. the LLM system prompt forbids mutations,
--      c. this function rejects anything that isn't a single SELECT/WITH
--         and wraps the user query inside an outer SELECT so even a
--         hostile inner expression cannot do more than read rows.

CREATE TABLE IF NOT EXISTS query_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id TEXT,
    question TEXT,
    sql TEXT NOT NULL,
    cached BOOLEAN NOT NULL DEFAULT FALSE,
    row_count INTEGER,
    execution_ms INTEGER,
    succeeded BOOLEAN NOT NULL,
    error_message TEXT,
    chip_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_query_log_asked_at ON query_log(asked_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_log_chip ON query_log(chip_id) WHERE chip_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- atlas_run_select(sql_text TEXT, max_rows INTEGER, timeout_ms INTEGER)
-- ---------------------------------------------------------------------------
-- Executes a single SELECT (or WITH ... SELECT) and returns its rows as a
-- JSONB array. Validation:
--   - the trimmed input may end with a single optional semicolon and must
--     not contain any other semicolon (blocks multi-statement injection)
--   - the first non-whitespace token must be SELECT or WITH (case-insensitive)
--   - execution runs under a SET LOCAL statement_timeout
--   - rows are capped via an outer LIMIT wrap
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION atlas_run_select(
    sql_text TEXT,
    max_rows INTEGER DEFAULT 1000,
    timeout_ms INTEGER DEFAULT 10000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    cleaned TEXT;
    head TEXT;
    result JSONB;
BEGIN
    cleaned := trim(both E' \t\n\r' FROM sql_text);
    -- One optional trailing semicolon is allowed; strip it.
    IF right(cleaned, 1) = ';' THEN
        cleaned := substring(cleaned FROM 1 FOR length(cleaned) - 1);
        cleaned := trim(both E' \t\n\r' FROM cleaned);
    END IF;
    IF cleaned = '' THEN
        RAISE EXCEPTION 'atlas_run_select: empty SQL';
    END IF;

    -- Block multi-statement input: no semicolons remain after stripping the
    -- trailing one. This is the primary injection defense.
    IF position(';' IN cleaned) > 0 THEN
        RAISE EXCEPTION 'atlas_run_select: multi-statement queries are not allowed';
    END IF;

    -- Leading keyword must be SELECT or WITH.
    head := upper(substring(cleaned FROM 1 FOR 7));
    IF substring(head FROM 1 FOR 7) <> 'SELECT ' AND
       substring(head FROM 1 FOR 6) <> 'SELECT' AND
       substring(head FROM 1 FOR 5) <> 'WITH ' AND
       substring(head FROM 1 FOR 4) <> 'WITH'
    THEN
        RAISE EXCEPTION 'atlas_run_select: query must start with SELECT or WITH';
    END IF;

    -- Per-call statement_timeout.
    EXECUTE format('SET LOCAL statement_timeout = %s', timeout_ms);

    -- Wrap the user query so the outer LIMIT acts as a hard cap regardless
    -- of what the inner query specifies. jsonb_agg(...) returns a single
    -- JSONB array; the COALESCE handles the zero-row case.
    EXECUTE format(
        'SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT * FROM (%s) AS inner_q LIMIT %s) AS t',
        cleaned,
        max_rows
    )
    INTO result;
    RETURN result;
END;
$$;

COMMENT ON FUNCTION atlas_run_select IS
'Phase 3 Ask Anything: execute a single SELECT/WITH query with statement_timeout and row cap. Returns JSONB array of rows. Rejects mutations and multi-statement input.';
