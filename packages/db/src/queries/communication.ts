/**
 * Named query helpers for `communication` and its edge tables.
 * See SPEC.md §3.2.4, §3.3.4, and §7 (semantic search via pgvector).
 */
import {
  err,
  isErr,
  ok,
  QueryError,
  type AtlasError,
  type Communication,
  type CommunicationSourcePlatform,
  type Result,
  type UUID,
} from '@atlas/core';
import { envelope, formatVector, parseVector, svc, toQueryError } from './_internal.js';

export type CommunicationInput = Omit<Communication, 'id' | 'ingested_at' | 'embedding'> & {
  embedding?: number[] | null;
};

function hydrate(row: Record<string, unknown>): Communication {
  return {
    ...(row as unknown as Communication),
    embedding: parseVector(row.embedding),
  };
}

/**
 * Insert a new Communication. The `(source_platform, source_record_id)`
 * unique constraint dedupes re-ingested records — duplicate inserts return
 * the existing row rather than failing.
 *
 * @example
 * ```ts
 * await createCommunication({
 *   source_platform: 'twitter',
 *   source_record_id: '1700000000',
 *   author_handle_raw: '@alicebuilds',
 *   content_text: 'Cursor just shipped composer mode',
 *   posted_at: '2026-02-12T17:00:00Z',
 *   topic_tags: [], vertical_tags: [],
 *   engagement_likes: 0, engagement_replies: 0, engagement_shares: 0, engagement_views: null,
 *   is_about_cursor: true, cursor_relevance_score: 0.9,
 *   author_person_id: null, sentiment_score: null, content_url: null,
 * });
 * ```
 */
export async function createCommunication(
  input: CommunicationInput,
): Promise<Result<Communication, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    source_platform: input.source_platform,
    source_record_id: input.source_record_id,
    author_person_id: input.author_person_id ?? null,
    author_handle_raw: input.author_handle_raw,
    content_text: input.content_text,
    content_url: input.content_url ?? null,
    posted_at: input.posted_at,
    sentiment_score: input.sentiment_score ?? null,
    topic_tags: input.topic_tags ?? [],
    vertical_tags: input.vertical_tags ?? [],
    engagement_likes: input.engagement_likes ?? 0,
    engagement_replies: input.engagement_replies ?? 0,
    engagement_shares: input.engagement_shares ?? 0,
    engagement_views: input.engagement_views ?? null,
    is_about_cursor: input.is_about_cursor ?? false,
    cursor_relevance_score: input.cursor_relevance_score ?? null,
    embedding: formatVector(input.embedding ?? null),
  };
  const result = await c.value
    .from('communication')
    .upsert(row, {
      onConflict: 'source_platform,source_record_id',
      ignoreDuplicates: false,
    })
    .select()
    .single();
  const env = envelope<Record<string, unknown>>('createCommunication', result);
  if (isErr(env)) return env;
  return ok(hydrate(env.value));
}

/** List Communications authored by a Person. */
export async function findCommunicationsByAuthor(
  personId: UUID,
  options?: { since?: Date | string; limit?: number },
): Promise<Result<Communication[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value
    .from('communication')
    .select()
    .eq('author_person_id', personId)
    .order('posted_at', { ascending: false });
  if (options?.since !== undefined) {
    const since = typeof options.since === 'string' ? options.since : options.since.toISOString();
    q = q.gte('posted_at', since);
  }
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error)
    return err(toQueryError('findCommunicationsByAuthor', result.error, { personId }));
  return ok(((result.data ?? []) as Record<string, unknown>[]).map(hydrate));
}

/** List Communications inside an inclusive time window, optionally filtered by platform. */
export async function findCommunicationsByTimeWindow(
  from: Date | string,
  to: Date | string,
  options?: { platform?: CommunicationSourcePlatform; limit?: number },
): Promise<Result<Communication[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const fromIso = typeof from === 'string' ? from : from.toISOString();
  const toIso = typeof to === 'string' ? to : to.toISOString();
  let q = c.value
    .from('communication')
    .select()
    .gte('posted_at', fromIso)
    .lte('posted_at', toIso)
    .order('posted_at', { ascending: false });
  if (options?.platform) q = q.eq('source_platform', options.platform);
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error)
    return err(toQueryError('findCommunicationsByTimeWindow', result.error, { fromIso, toIso }));
  return ok(((result.data ?? []) as Record<string, unknown>[]).map(hydrate));
}

/**
 * Communications that mention Cursor (`is_about_cursor = true`), optionally
 * scoped by minimum relevance score.
 */
export async function findCursorMentions(options?: {
  minRelevance?: number;
  since?: Date | string;
  limit?: number;
}): Promise<Result<Communication[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value
    .from('communication')
    .select()
    .eq('is_about_cursor', true)
    .order('cursor_relevance_score', { ascending: false, nullsFirst: false });
  if (options?.minRelevance !== undefined)
    q = q.gte('cursor_relevance_score', options.minRelevance);
  if (options?.since !== undefined) {
    const since = typeof options.since === 'string' ? options.since : options.since.toISOString();
    q = q.gte('posted_at', since);
  }
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error) return err(toQueryError('findCursorMentions', result.error));
  return ok(((result.data ?? []) as Record<string, unknown>[]).map(hydrate));
}

/** One hit returned by `semanticSearch`. */
export interface SemanticSearchHit {
  id: UUID;
  source_platform: string;
  source_record_id: string;
  author_person_id: UUID | null;
  author_handle_raw: string;
  content_text: string;
  content_url: string | null;
  posted_at: string;
  similarity: number;
}

/**
 * Cosine-similarity search over communication embeddings. Calls the
 * `match_communications` SQL function defined in migration 0001.
 *
 * @example
 * ```ts
 * const hits = await semanticSearch(queryEmbedding, { matchCount: 10, cursorOnly: true });
 * ```
 */
export async function semanticSearch(
  embedding: number[],
  options?: { matchCount?: number; cursorOnly?: boolean },
): Promise<Result<SemanticSearchHit[], AtlasError>> {
  if (embedding.length !== 1536) {
    return err(
      new QueryError(
        `semanticSearch: expected 1536-dim embedding, got ${embedding.length}`,
        'QUERY_VALIDATION_FAILED',
        { length: embedding.length },
      ),
    );
  }
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.rpc('match_communications', {
    query_embedding: formatVector(embedding),
    match_count: options?.matchCount ?? 20,
    cursor_only: options?.cursorOnly ?? false,
  });
  if (result.error) return err(toQueryError('semanticSearch', result.error));
  return ok((result.data ?? []) as SemanticSearchHit[]);
}
