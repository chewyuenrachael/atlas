/**
 * Supabase-backed implementation of {@link RawGithubRepoStore}.
 *
 * SPEC ref: SPEC.md §3.5, §5.2.2.
 */
import { IngestionError, type UUID } from '@atlas/core';
import { GithubQueries } from '@atlas/db';
import type { RawGithubRepoStore } from './repo-search-adapter.js';
import type { RawGithubRepoMatch } from './types.js';

export class SupabaseRawGithubRepoStore implements RawGithubRepoStore {
  async insert(record: RawGithubRepoMatch): Promise<{ rawId: UUID; existed: boolean }> {
    const result = await GithubQueries.insertRawGithubRepo({
      repo_id: record.repoId,
      repo_node_id: record.repoNodeId,
      raw_payload: serialize(record),
    });
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawGithubRepoStore.insert failed for repo_id=${record.repoId}`,
        'INGESTION_FAILED',
        { repo_id: record.repoId },
        result.error,
      );
    }
    return { rawId: result.value.id, existed: result.value.existed };
  }

  async getById(rawId: UUID): Promise<RawGithubRepoMatch | null> {
    const result = await GithubQueries.getRawGithubRepoById(rawId);
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawGithubRepoStore.getById failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
    if (!result.value) return null;
    return deserialize(result.value.raw_payload);
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const result = await GithubQueries.markRawGithubRepoNormalized(rawId, 'success');
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawGithubRepoStore.markNormalized failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }

  async markFailed(rawId: UUID, errorMessage: string): Promise<void> {
    const result = await GithubQueries.markRawGithubRepoNormalized(rawId, 'failed', errorMessage);
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawGithubRepoStore.markFailed failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }
}

function serialize(record: RawGithubRepoMatch): Record<string, unknown> {
  return {
    repo_id: record.repoId,
    repo_node_id: record.repoNodeId,
    repo: record.repo,
    readme: record.readme,
    relevance: record.relevance,
    fetched_at: record.fetchedAt,
    payload_hash: record.payloadHash,
  };
}

function deserialize(payload: Record<string, unknown>): RawGithubRepoMatch {
  const raw = payload as {
    repo_id?: number;
    repo_node_id?: string;
    repo?: RawGithubRepoMatch['repo'];
    readme?: string | null;
    relevance?: RawGithubRepoMatch['relevance'];
    fetched_at?: string;
    payload_hash?: string;
  };
  return {
    repoId: raw.repo_id ?? 0,
    repoNodeId: raw.repo_node_id ?? '',
    repo: raw.repo ?? ({} as RawGithubRepoMatch['repo']),
    readme: raw.readme ?? null,
    relevance:
      raw.relevance ??
      ({
        inReadme: false,
        inRepoMetadata: false,
        inCodeOnly: false,
        cursorRelevanceScore: 0,
      } as RawGithubRepoMatch['relevance']),
    fetchedAt: raw.fetched_at ?? '',
    payloadHash: raw.payload_hash ?? '',
  };
}
