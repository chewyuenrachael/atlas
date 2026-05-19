/**
 * @atlas/db — Supabase client + named query helpers.
 *
 * All read/write SQL access to the Atlas Postgres database flows through
 * this package. Adapters, workflows, and the API layer call the helpers in
 * `./queries/*` rather than executing raw SQL themselves.
 */
export { getAnonClient, getServiceClient, __resetClientsForTesting } from './client.js';
export type { SupabaseClient } from './client.js';
export * from './queries/index.js';
