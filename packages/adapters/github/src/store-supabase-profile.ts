/**
 * Supabase-backed implementation of {@link RawGithubProfileStore}.
 *
 * SPEC ref: SPEC.md §3.5, §5.2.2.
 */
import { IngestionError, type UUID } from '@atlas/core';
import { GithubQueries } from '@atlas/db';
import type { RawGithubProfileStore } from './profile-adapter.js';
import type { RawGithubProfile } from './types.js';

export class SupabaseRawGithubProfileStore implements RawGithubProfileStore {
  async insert(record: RawGithubProfile): Promise<{ rawId: UUID; existed: boolean }> {
    const result = await GithubQueries.insertRawGithubProfile({
      github_login: record.login,
      raw_payload: serialize(record),
    });
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawGithubProfileStore.insert failed for login=${record.login}`,
        'INGESTION_FAILED',
        { login: record.login },
        result.error,
      );
    }
    return { rawId: result.value.id, existed: result.value.existed };
  }

  async getById(rawId: UUID): Promise<RawGithubProfile | null> {
    const result = await GithubQueries.getRawGithubProfileById(rawId);
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawGithubProfileStore.getById failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
    if (!result.value) return null;
    return deserialize(result.value.raw_payload);
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const result = await GithubQueries.markRawGithubProfileNormalized(rawId, 'success');
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawGithubProfileStore.markNormalized failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }

  async markFailed(rawId: UUID, errorMessage: string): Promise<void> {
    const result = await GithubQueries.markRawGithubProfileNormalized(
      rawId,
      'failed',
      errorMessage,
    );
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawGithubProfileStore.markFailed failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }
}

function serialize(record: RawGithubProfile): Record<string, unknown> {
  return {
    login: record.login,
    profile: record.profile,
    top_repos: record.topRepos,
    fetched_at: record.fetchedAt,
    payload_hash: record.payloadHash,
  };
}

function deserialize(payload: Record<string, unknown>): RawGithubProfile {
  const raw = payload as {
    login?: string;
    profile?: RawGithubProfile['profile'];
    top_repos?: RawGithubProfile['topRepos'];
    fetched_at?: string;
    payload_hash?: string;
  };
  return {
    login: raw.login ?? '',
    profile: raw.profile ?? ({} as RawGithubProfile['profile']),
    topRepos: raw.top_repos ?? [],
    fetchedAt: raw.fetched_at ?? '',
    payloadHash: raw.payload_hash ?? '',
  };
}
