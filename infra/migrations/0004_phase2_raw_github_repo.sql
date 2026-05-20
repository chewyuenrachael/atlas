-- Phase 2D: GitHub repo-search raw envelope.
-- The GitHub repo-search adapter persists one row per discovered repository
-- so a single fetch + relevance score is durable across re-runs (SPEC.md
-- §3.5, §5.2.2). The numeric `repo_id` from the REST API is the unique key.
CREATE TABLE IF NOT EXISTS raw_github_repo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id BIGINT NOT NULL UNIQUE,
    repo_node_id TEXT NOT NULL,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_github_repo_status ON raw_github_repo(normalization_status);
CREATE INDEX IF NOT EXISTS idx_raw_github_repo_node_id ON raw_github_repo(repo_node_id);
