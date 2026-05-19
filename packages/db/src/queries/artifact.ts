/**
 * Named query helpers for `artifact`. See SPEC.md §3.2.5.
 */
import {
  err,
  isErr,
  ok,
  type Artifact,
  type ArtifactType,
  type AtlasError,
  type Result,
  type UUID,
} from '@atlas/core';
import { envelope, formatVector, parseVector, svc, toQueryError } from './_internal.js';

export type ArtifactInput = Omit<Artifact, 'id' | 'created_at' | 'embedding'> & {
  embedding?: number[] | null;
};

function hydrate(row: Record<string, unknown>): Artifact {
  return {
    ...(row as unknown as Artifact),
    embedding: parseVector(row.embedding),
  };
}

/**
 * Insert a new Artifact row.
 *
 * @example
 * ```ts
 * await createArtifact({ artifact_type: 'workshop_recording', title: 'Cursor Composer Deep Dive', ... });
 * ```
 */
export async function createArtifact(input: ArtifactInput): Promise<Result<Artifact, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    artifact_type: input.artifact_type,
    title: input.title,
    creator_person_id: input.creator_person_id ?? null,
    derived_from_event_id: input.derived_from_event_id ?? null,
    content_url: input.content_url ?? null,
    content_text: input.content_text ?? null,
    vertical_tags: input.vertical_tags ?? [],
    technical_tags: input.technical_tags ?? [],
    is_public: input.is_public ?? true,
    quality_score: input.quality_score ?? null,
    embedding: formatVector(input.embedding ?? null),
    metadata: input.metadata ?? {},
  };
  const result = await c.value.from('artifact').insert(row).select().single();
  const env = envelope<Record<string, unknown>>('createArtifact', result);
  if (isErr(env)) return env;
  return ok(hydrate(env.value));
}

/** List Artifacts created by the given Person. */
export async function findArtifactsByCreator(
  personId: UUID,
): Promise<Result<Artifact[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('artifact')
    .select()
    .eq('creator_person_id', personId)
    .order('created_at', { ascending: false });
  if (result.error) return err(toQueryError('findArtifactsByCreator', result.error, { personId }));
  return ok(((result.data ?? []) as Record<string, unknown>[]).map(hydrate));
}

/** List Artifacts derived from the given Event. */
export async function findArtifactsByEvent(eventId: UUID): Promise<Result<Artifact[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('artifact')
    .select()
    .eq('derived_from_event_id', eventId)
    .order('created_at', { ascending: false });
  if (result.error) return err(toQueryError('findArtifactsByEvent', result.error, { eventId }));
  return ok(((result.data ?? []) as Record<string, unknown>[]).map(hydrate));
}

/** List Artifacts by `artifact_type`. */
export async function findArtifactsByType(
  type: ArtifactType,
): Promise<Result<Artifact[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('artifact')
    .select()
    .eq('artifact_type', type)
    .order('created_at', { ascending: false });
  if (result.error) return err(toQueryError('findArtifactsByType', result.error, { type }));
  return ok(((result.data ?? []) as Record<string, unknown>[]).map(hydrate));
}
