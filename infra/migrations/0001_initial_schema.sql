-- =============================================================================
-- Cursor Community Atlas — migration 0001_initial_schema
-- =============================================================================
-- Realizes SPEC.md §3 (entities, edges, raw tables), §4.4/§4.5 (resolution
-- audit), §6.2 (entity event log), §6.4 (materialized views), §7.2 (named SQL
-- functions), §10.5 (access audit log), plus the human review queue referenced
-- throughout the spec.
--
-- All DDL is idempotent (IF NOT EXISTS / CREATE OR REPLACE) so re-running the
-- migration against an already-bootstrapped database is a no-op.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions (SPEC.md §2.3, §3.2.4 embedding column, §4.2 fuzzy matching).
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. company (SPEC.md §3.2.2).
--    Created first because `person.employer_company_id` references it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name TEXT NOT NULL UNIQUE,
    domain TEXT,
    aliases TEXT[] DEFAULT '{}',
    vertical TEXT CHECK (vertical IN ('finance', 'healthcare', 'defense', 'government', 'energy', 'retail', 'tech', 'media', 'manufacturing', 'consulting', 'education', 'legacy_modernization', 'startup', 'other')),
    employee_count_tier TEXT CHECK (employee_count_tier IN ('seed', 'startup', 'growth', 'midmarket', 'enterprise', 'fortune_500')),
    fortune_rank INTEGER,
    geographic_hq_city TEXT,
    geographic_hq_country TEXT,
    target_account_status TEXT CHECK (target_account_status IN ('not_target', 'prospect', 'active_opportunity', 'customer', 'churned')),
    enterprise_account_id TEXT,
    aggregate_seat_count INTEGER DEFAULT 0,
    aggregate_composer_adoption NUMERIC(3,2),
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_company_domain ON company(domain);
CREATE INDEX IF NOT EXISTS idx_company_vertical ON company(vertical);
CREATE INDEX IF NOT EXISTS idx_company_target ON company(target_account_status) WHERE target_account_status != 'not_target';
CREATE INDEX IF NOT EXISTS idx_company_aliases_gin ON company USING gin(aliases);
CREATE INDEX IF NOT EXISTS idx_company_name_trgm ON company USING gin(canonical_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 2. person (SPEC.md §3.2.1).
--    FKs to company; predates program (which FKs back to person).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name TEXT NOT NULL,
    names_seen TEXT[] DEFAULT '{}',
    emails_seen TEXT[] DEFAULT '{}',
    primary_email TEXT,
    location_city TEXT,
    location_country TEXT,
    location_timezone TEXT,
    employer_company_id UUID REFERENCES company(id),
    employer_seen_at TIMESTAMPTZ,
    role TEXT,
    seniority TEXT CHECK (seniority IN ('junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp', 'cxo', 'founder', 'unknown')),
    vertical TEXT,
    languages TEXT[] DEFAULT '{}',
    persona_classification TEXT,
    persona_confidence NUMERIC(3,2),
    lifecycle_stage TEXT CHECK (lifecycle_stage IN ('lurker', 'engaged', 'event_attendee', 'event_host', 'ambassador_candidate', 'ambassador', 'regional_lead', 'champion', 'dormant', 'churned')),
    activity_score NUMERIC(5,2) DEFAULT 0,
    churn_risk NUMERIC(3,2) DEFAULT 0,
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_person_employer ON person(employer_company_id);
CREATE INDEX IF NOT EXISTS idx_person_location ON person(location_country, location_city);
CREATE INDEX IF NOT EXISTS idx_person_lifecycle ON person(lifecycle_stage) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_person_active_score ON person(activity_score DESC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_person_names_gin ON person USING gin(names_seen);
CREATE INDEX IF NOT EXISTS idx_person_emails_gin ON person USING gin(emails_seen);
CREATE INDEX IF NOT EXISTS idx_person_primary_email ON person(primary_email) WHERE primary_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_person_name_trgm ON person USING gin(canonical_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. person_platform_identity (SPEC.md §3.2.1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_platform_identity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('twitter', 'github', 'linkedin', 'luma', 'slack', 'discord', 'forum', 'cursor_product', 'hackernews', 'reddit', 'youtube', 'email')),
    handle TEXT NOT NULL,
    platform_user_id TEXT,
    profile_url TEXT,
    follower_count INTEGER,
    verified BOOLEAN DEFAULT FALSE,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolution_confidence NUMERIC(3,2) DEFAULT 1.0,
    resolution_method TEXT CHECK (resolution_method IN ('explicit_link', 'heuristic_match', 'embedding_match', 'human_verified', 'self_reported')),
    UNIQUE(platform, handle),
    UNIQUE(platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_ppi_person ON person_platform_identity(person_id);
CREATE INDEX IF NOT EXISTS idx_ppi_platform_handle ON person_platform_identity(platform, handle);

-- ---------------------------------------------------------------------------
-- 4. program (SPEC.md §3.2.6).
--    FK to person.owner_person_id; predates event (FKs back).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS program (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    program_type TEXT NOT NULL,
    owner_person_id UUID REFERENCES person(id),
    description TEXT,
    is_vertical BOOLEAN DEFAULT FALSE,
    vertical TEXT,
    active_cities TEXT[] DEFAULT '{}',
    target_cities TEXT[] DEFAULT '{}',
    kpis JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_program_owner ON program(owner_person_id);
CREATE INDEX IF NOT EXISTS idx_program_active ON program(is_active);
CREATE INDEX IF NOT EXISTS idx_program_type ON program(program_type);

-- ---------------------------------------------------------------------------
-- 5. event (SPEC.md §3.2.3).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT,
    program_id UUID REFERENCES program(id),
    program_type TEXT CHECK (program_type IN ('cafe_cursor', 'hackathon', 'workshop', 'meetup', 'vertical_finance', 'vertical_healthcare', 'vertical_defense', 'campus', 'ambassador_internal', 'other')),
    event_format TEXT CHECK (event_format IN ('in_person', 'virtual', 'hybrid')),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    timezone TEXT,
    venue_city TEXT,
    venue_country TEXT,
    venue_name TEXT,
    venue_company_id UUID REFERENCES company(id),
    host_company_id UUID REFERENCES company(id),
    status TEXT CHECK (status IN ('proposed', 'scheduled', 'live', 'completed', 'cancelled')),
    registered_count INTEGER DEFAULT 0,
    attended_count INTEGER DEFAULT 0,
    repeat_attendee_count INTEGER DEFAULT 0,
    sentiment_score NUMERIC(3,2),
    source_url TEXT,
    luma_event_id TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_event_dates ON event(starts_at);
CREATE INDEX IF NOT EXISTS idx_event_program ON event(program_id);
CREATE INDEX IF NOT EXISTS idx_event_location ON event(venue_country, venue_city);
CREATE INDEX IF NOT EXISTS idx_event_status ON event(status);
CREATE INDEX IF NOT EXISTS idx_event_venue_company ON event(venue_company_id);
CREATE INDEX IF NOT EXISTS idx_event_host_company ON event(host_company_id);

-- ---------------------------------------------------------------------------
-- 6. communication (SPEC.md §3.2.4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communication (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_platform TEXT NOT NULL CHECK (source_platform IN ('twitter', 'reddit', 'hackernews', 'youtube', 'forum', 'slack_public', 'discord', 'linkedin', 'blog', 'podcast')),
    source_record_id TEXT NOT NULL,
    author_person_id UUID REFERENCES person(id),
    author_handle_raw TEXT NOT NULL,
    content_text TEXT NOT NULL,
    content_url TEXT,
    posted_at TIMESTAMPTZ NOT NULL,
    sentiment_score NUMERIC(3,2),
    topic_tags TEXT[] DEFAULT '{}',
    vertical_tags TEXT[] DEFAULT '{}',
    engagement_likes INTEGER DEFAULT 0,
    engagement_replies INTEGER DEFAULT 0,
    engagement_shares INTEGER DEFAULT 0,
    engagement_views INTEGER,
    is_about_cursor BOOLEAN DEFAULT FALSE,
    cursor_relevance_score NUMERIC(3,2),
    embedding VECTOR(1536),
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_platform, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_comm_author ON communication(author_person_id);
CREATE INDEX IF NOT EXISTS idx_comm_posted ON communication(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_comm_topic_gin ON communication USING gin(topic_tags);
CREATE INDEX IF NOT EXISTS idx_comm_vertical_gin ON communication USING gin(vertical_tags);
CREATE INDEX IF NOT EXISTS idx_comm_cursor_rel ON communication(cursor_relevance_score DESC) WHERE is_about_cursor = TRUE;
-- ivfflat index per SPEC.md §3.2.4. Empty until populated; lists=100 is the
-- recommended starting point for cosine similarity on 1536-dim vectors.
CREATE INDEX IF NOT EXISTS idx_comm_embedding ON communication USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ---------------------------------------------------------------------------
-- 7. artifact (SPEC.md §3.2.5).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_type TEXT NOT NULL CHECK (artifact_type IN ('workshop_recording', 'hackathon_submission', 'demo_video', 'rules_template', 'mcp_config', 'agent_definition', 'blog_post', 'documentation', 'tutorial', 'case_study')),
    title TEXT NOT NULL,
    creator_person_id UUID REFERENCES person(id),
    derived_from_event_id UUID REFERENCES event(id),
    content_url TEXT,
    content_text TEXT,
    vertical_tags TEXT[] DEFAULT '{}',
    technical_tags TEXT[] DEFAULT '{}',
    is_public BOOLEAN DEFAULT TRUE,
    quality_score NUMERIC(3,2),
    embedding VECTOR(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_artifact_creator ON artifact(creator_person_id);
CREATE INDEX IF NOT EXISTS idx_artifact_event ON artifact(derived_from_event_id);
CREATE INDEX IF NOT EXISTS idx_artifact_type ON artifact(artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifact_tags_gin ON artifact USING gin(technical_tags);
CREATE INDEX IF NOT EXISTS idx_artifact_vertical_gin ON artifact USING gin(vertical_tags);
CREATE INDEX IF NOT EXISTS idx_artifact_embedding ON artifact USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ---------------------------------------------------------------------------
-- 8. signal (SPEC.md §3.2.7).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signal (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    signal_type TEXT NOT NULL CHECK (signal_type IN (
        'event_attended', 'event_hosted', 'public_post_about_cursor',
        'positive_sentiment', 'negative_sentiment', 'product_usage_spike',
        'churn_risk_indicator', 'employer_change', 'role_change',
        'enterprise_advocacy', 'feedback_submitted', 'feature_request',
        'workflow_contributed', 'community_help_provided', 'organizer_candidate_qualified'
    )),
    value NUMERIC,
    confidence NUMERIC(3,2) DEFAULT 1.0,
    observed_at TIMESTAMPTZ NOT NULL,
    source_communication_id UUID REFERENCES communication(id),
    source_event_id UUID REFERENCES event(id),
    source_artifact_id UUID REFERENCES artifact(id),
    decays_by TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_signal_person ON signal(person_id);
CREATE INDEX IF NOT EXISTS idx_signal_type_time ON signal(signal_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_decay ON signal(decays_by) WHERE decays_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signal_source_comm ON signal(source_communication_id);
CREATE INDEX IF NOT EXISTS idx_signal_source_event ON signal(source_event_id);
CREATE INDEX IF NOT EXISTS idx_signal_source_artifact ON signal(source_artifact_id);

-- ===========================================================================
-- Edge tables (SPEC.md §3.3).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- person_event (SPEC.md §3.3.1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('organizer', 'co_organizer', 'speaker', 'attendee', 'registered_no_show', 'declined')),
    registered_at TIMESTAMPTZ,
    attended_at TIMESTAMPTZ,
    luma_role_raw TEXT,
    post_event_sentiment NUMERIC(3,2),
    post_event_feedback TEXT,
    UNIQUE(person_id, event_id, role)
);

CREATE INDEX IF NOT EXISTS idx_pe_person ON person_event(person_id);
CREATE INDEX IF NOT EXISTS idx_pe_event ON person_event(event_id);
CREATE INDEX IF NOT EXISTS idx_pe_role ON person_event(role);

-- ---------------------------------------------------------------------------
-- person_company (SPEC.md §3.3.2).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_company (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    role TEXT,
    seniority TEXT CHECK (seniority IN ('junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp', 'cxo', 'founder', 'unknown')),
    is_current BOOLEAN DEFAULT TRUE,
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    source TEXT CHECK (source IN ('linkedin', 'email_domain', 'self_reported', 'github_bio', 'luma_form')),
    confidence NUMERIC(3,2) DEFAULT 1.0,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pc_person_current ON person_company(person_id) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_pc_company_current ON person_company(company_id) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_pc_person ON person_company(person_id);
CREATE INDEX IF NOT EXISTS idx_pc_company ON person_company(company_id);

-- ---------------------------------------------------------------------------
-- person_person_edge (SPEC.md §3.3.3).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_person_edge (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_person_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    target_person_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    edge_type TEXT NOT NULL CHECK (edge_type IN ('mentions', 'replies_to', 'co_hosts_event', 'colleague_at_company', 'mentored_by', 'introduced_to')),
    strength INTEGER DEFAULT 1,
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    UNIQUE(source_person_id, target_person_id, edge_type),
    CHECK (source_person_id <> target_person_id)
);

CREATE INDEX IF NOT EXISTS idx_ppe_source ON person_person_edge(source_person_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_ppe_target ON person_person_edge(target_person_id, edge_type);

-- ---------------------------------------------------------------------------
-- communication_mentions_person (SPEC.md §3.3.4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communication_mentions_person (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    communication_id UUID NOT NULL REFERENCES communication(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    confidence NUMERIC(3,2) DEFAULT 1.0,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(communication_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_cmp_communication ON communication_mentions_person(communication_id);
CREATE INDEX IF NOT EXISTS idx_cmp_person ON communication_mentions_person(person_id);

-- ---------------------------------------------------------------------------
-- communication_mentions_company (SPEC.md §3.3.4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communication_mentions_company (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    communication_id UUID NOT NULL REFERENCES communication(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    confidence NUMERIC(3,2) DEFAULT 1.0,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(communication_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_cmc_communication ON communication_mentions_company(communication_id);
CREATE INDEX IF NOT EXISTS idx_cmc_company ON communication_mentions_company(company_id);

-- ---------------------------------------------------------------------------
-- artifact_uses_artifact (SPEC.md §3.3.4 — derivative artifacts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact_uses_artifact (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_artifact_id UUID NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
    target_artifact_id UUID NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
    metadata JSONB DEFAULT '{}',
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_artifact_id, target_artifact_id),
    CHECK (source_artifact_id <> target_artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_aua_source ON artifact_uses_artifact(source_artifact_id);
CREATE INDEX IF NOT EXISTS idx_aua_target ON artifact_uses_artifact(target_artifact_id);

-- ---------------------------------------------------------------------------
-- program_managed_by_person (SPEC.md §3.3.4 — regional leads, ambassadors).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS program_managed_by_person (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES program(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    role TEXT,
    is_current BOOLEAN DEFAULT TRUE,
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    UNIQUE(program_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS idx_pmbp_program ON program_managed_by_person(program_id);
CREATE INDEX IF NOT EXISTS idx_pmbp_person ON program_managed_by_person(person_id);
CREATE INDEX IF NOT EXISTS idx_pmbp_current ON program_managed_by_person(program_id, person_id) WHERE is_current = TRUE;

-- ---------------------------------------------------------------------------
-- event_part_of_program (SPEC.md §3.3.4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_part_of_program (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    program_id UUID NOT NULL REFERENCES program(id) ON DELETE CASCADE,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, program_id)
);

CREATE INDEX IF NOT EXISTS idx_epop_event ON event_part_of_program(event_id);
CREATE INDEX IF NOT EXISTS idx_epop_program ON event_part_of_program(program_id);

-- ===========================================================================
-- Raw source tables (SPEC.md §3.5). One per ingested source. Every adapter
-- writes here before normalization. Identical envelope.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS raw_luma_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    luma_event_id TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_luma_status ON raw_luma_event(normalization_status);

CREATE TABLE IF NOT EXISTS raw_twitter_post (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tweet_id TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_twitter_status ON raw_twitter_post(normalization_status);

CREATE TABLE IF NOT EXISTS raw_github_profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_login TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_github_profile_status ON raw_github_profile(normalization_status);

CREATE TABLE IF NOT EXISTS raw_github_commit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_sha TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_github_commit_status ON raw_github_commit(normalization_status);

CREATE TABLE IF NOT EXISTS raw_linkedin_profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    linkedin_handle TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_linkedin_status ON raw_linkedin_profile(normalization_status);

CREATE TABLE IF NOT EXISTS raw_reddit_post (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reddit_post_id TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_reddit_status ON raw_reddit_post(normalization_status);

CREATE TABLE IF NOT EXISTS raw_hackernews_item (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hn_item_id TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_hn_status ON raw_hackernews_item(normalization_status);

CREATE TABLE IF NOT EXISTS raw_youtube_video (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    youtube_video_id TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_youtube_status ON raw_youtube_video(normalization_status);

CREATE TABLE IF NOT EXISTS raw_cursor_forum_post (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    forum_post_id TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_cursor_forum_status ON raw_cursor_forum_post(normalization_status);

CREATE TABLE IF NOT EXISTS raw_cursor_product_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_event_id TEXT NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_at TIMESTAMPTZ,
    normalization_status TEXT CHECK (normalization_status IN ('pending', 'success', 'failed', 'skipped')),
    normalization_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_cursor_product_status ON raw_cursor_product_event(normalization_status);

-- ===========================================================================
-- Audit and operational tables (SPEC.md §4.4, §4.5, §6.2, §10.5, review queue).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- entity_event_log (SPEC.md §6.2). Append-only event sourcing log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_event_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    payload JSONB NOT NULL,
    causation_id UUID,
    correlation_id UUID
);

CREATE INDEX IF NOT EXISTS idx_eel_entity ON entity_event_log(entity_type, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_eel_correlation ON entity_event_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_eel_event_type_time ON entity_event_log(event_type, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- resolution_decision (SPEC.md §4.4). Immutable audit of resolver outcomes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resolution_decision (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action TEXT NOT NULL CHECK (action IN ('merge', 'create_new', 'human_review', 'skip')),
    candidate_record_source TEXT NOT NULL,
    candidate_record_id TEXT NOT NULL,
    matched_person_id UUID REFERENCES person(id),
    confidence_score NUMERIC(3,2) NOT NULL,
    signals JSONB NOT NULL,
    decided_by TEXT NOT NULL CHECK (decided_by IN ('system', 'human')),
    human_reviewer TEXT,
    reasoning TEXT
);

CREATE INDEX IF NOT EXISTS idx_resolution_person ON resolution_decision(matched_person_id);
CREATE INDEX IF NOT EXISTS idx_resolution_time ON resolution_decision(decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_resolution_candidate ON resolution_decision(candidate_record_source, candidate_record_id);
CREATE INDEX IF NOT EXISTS idx_resolution_action ON resolution_decision(action);

-- ---------------------------------------------------------------------------
-- resolution_conflict (SPEC.md §4.5).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resolution_conflict (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    person_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    conflicting_evidence JSONB NOT NULL,
    status TEXT CHECK (status IN ('pending_review', 'confirmed_merge', 'split_required', 'resolved')),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,
    resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_rconflict_person ON resolution_conflict(person_id);
CREATE INDEX IF NOT EXISTS idx_rconflict_status ON resolution_conflict(status);
CREATE INDEX IF NOT EXISTS idx_rconflict_detected ON resolution_conflict(detected_at DESC);

-- ---------------------------------------------------------------------------
-- access_audit_log (SPEC.md §10.5). PII-touching reads/writes are logged here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID,
    success BOOLEAN NOT NULL,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_aal_user_time ON access_audit_log(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_aal_resource ON access_audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_aal_time ON access_audit_log(occurred_at DESC);

-- ---------------------------------------------------------------------------
-- human_review_queue. Workflows that produce drafts (outreach, briefings) and
-- the identity resolver enqueue items here. SPEC.md §4.2 (resolution review),
-- §8.3 (workflow outputs).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS human_review_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'escalated')),
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    reviewer TEXT,
    decision_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_hrq_status ON human_review_queue(status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_hrq_item_type ON human_review_queue(item_type);
CREATE INDEX IF NOT EXISTS idx_hrq_enqueued ON human_review_queue(enqueued_at DESC);

-- ===========================================================================
-- Materialized views (SPEC.md §6.4, Appendix A.1).
-- Created WITH NO DATA on an empty schema. Refresh is scheduled in Phase 4.
-- ===========================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_city_signal AS
SELECT
    p.location_city,
    p.location_country,
    COUNT(DISTINCT p.id) AS total_known_people,
    COUNT(DISTINCT CASE WHEN p.lifecycle_stage IN ('ambassador', 'regional_lead') THEN p.id END) AS ambassador_count,
    COUNT(DISTINCT e.id) AS event_count_last_180d,
    AVG(p.activity_score) AS avg_activity_score,
    COUNT(DISTINCT CASE WHEN c.posted_at > NOW() - INTERVAL '90 days' AND c.is_about_cursor THEN c.id END) AS recent_mentions
FROM person p
LEFT JOIN person_event pe ON p.id = pe.person_id
LEFT JOIN event e ON pe.event_id = e.id AND e.starts_at > NOW() - INTERVAL '180 days'
LEFT JOIN communication c ON c.author_person_id = p.id
WHERE p.location_city IS NOT NULL
GROUP BY p.location_city, p.location_country
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_city_signal ON mv_city_signal(location_country, location_city);

-- ===========================================================================
-- Named SQL functions (SPEC.md §7.2, Appendix A.2).
-- ===========================================================================

CREATE OR REPLACE FUNCTION find_organizer_candidates(
    target_city TEXT,
    target_country TEXT,
    limit_n INTEGER DEFAULT 20
)
RETURNS TABLE(person_id UUID, score NUMERIC)
LANGUAGE SQL STABLE
AS $$
    WITH local_active AS (
        SELECT
            p.id,
            p.activity_score,
            (
                SELECT COUNT(*) FROM communication c
                WHERE c.author_person_id = p.id
                  AND c.is_about_cursor
                  AND c.posted_at > NOW() - INTERVAL '90 days'
            ) AS recent_cursor_posts,
            (
                SELECT MAX(ppi.follower_count) FROM person_platform_identity ppi
                WHERE ppi.person_id = p.id
            ) AS max_audience
        FROM person p
        WHERE p.location_city = target_city
          AND p.location_country = target_country
          AND p.is_active = TRUE
          AND (p.lifecycle_stage IS NULL OR p.lifecycle_stage NOT IN ('ambassador', 'regional_lead'))
    )
    SELECT
        id AS person_id,
        (0.4 * activity_score + 0.3 * LN(1 + COALESCE(max_audience, 0)) + 0.3 * recent_cursor_posts)::NUMERIC AS score
    FROM local_active
    ORDER BY score DESC
    LIMIT limit_n;
$$;

-- ---------------------------------------------------------------------------
-- match_communications: pgvector cosine-similarity search.
-- Used by `CommunicationQueries.semanticSearch` so application code stays on
-- the Supabase PostgREST surface instead of opening raw pg connections.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_communications(
    query_embedding VECTOR(1536),
    match_count INTEGER DEFAULT 20,
    cursor_only BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(
    id UUID,
    source_platform TEXT,
    source_record_id TEXT,
    author_person_id UUID,
    author_handle_raw TEXT,
    content_text TEXT,
    content_url TEXT,
    posted_at TIMESTAMPTZ,
    similarity NUMERIC
)
LANGUAGE SQL STABLE
AS $$
    SELECT
        c.id,
        c.source_platform,
        c.source_record_id,
        c.author_person_id,
        c.author_handle_raw,
        c.content_text,
        c.content_url,
        c.posted_at,
        (1 - (c.embedding <=> query_embedding))::NUMERIC AS similarity
    FROM communication c
    WHERE c.embedding IS NOT NULL
      AND (NOT cursor_only OR c.is_about_cursor)
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
$$;

-- =============================================================================
-- End of migration 0001_initial_schema.sql
-- =============================================================================
