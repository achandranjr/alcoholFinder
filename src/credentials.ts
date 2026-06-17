import { loadAllCredentials, upsertCredentials } from './db.js';

/**
 * Per-source credential store for user-added sources, kept out of both the
 * source definitions and the env. Backed by the `source_credentials` table in
 * Postgres/Supabase (no filesystem writes — that's required for serverless).
 *
 * Reads go through a synchronous in-process cache so the source runtimes can
 * call getCredentials() without awaiting. Call loadCredentials() once at
 * startup (and the worker refreshes it before each run) to populate it.
 */

type Store = Record<string, Record<string, string>>;

let cache: Store = {};

/** Populate the in-process cache from the DB. Call at startup / before a run. */
export async function loadCredentials(): Promise<void> {
  cache = await loadAllCredentials();
}

export function getCredentials(sourceId: string): Record<string, string> {
  return cache[sourceId] ?? {};
}

export async function setCredentials(
  sourceId: string,
  creds: Record<string, string>,
): Promise<void> {
  await upsertCredentials(sourceId, creds);
  cache[sourceId] = { ...cache[sourceId], ...creds };
}
