import pg from 'pg';
import { config } from './config.js';
import type { KeyedCandidate, RunResult } from './types.js';

// Supabase (and most hosted Postgres) require TLS; local Postgres usually does
// not. Auto-detect from the host so the same code works in dev and on Vercel.
// (Supabase's certs chain through a pooler, so we don't verify the chain.)
const isLocal = /(@|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]/.test(config.DATABASE_URL);
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  // Serverless invocations are short-lived; keep the pool tiny so we don't
  // exhaust Supabase's connection limit across many cold functions.
  max: Number(process.env.PGPOOL_MAX ?? 3),
});

/* ------------------------------------------------------------------ products */

/**
 * Given a set of dedup keys, return the subset that already exists in the DB.
 * This is the read that BOTH live and test runs use to decide "new vs known".
 */
export async function findExistingKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const { rows } = await pool.query<{ dedup_key: string }>(
    'SELECT dedup_key FROM products WHERE dedup_key = ANY($1::text[])',
    [keys],
  );
  return new Set(rows.map((r) => r.dedup_key));
}

/** Persist newly discovered products. Only ever called on LIVE runs. */
export async function insertProducts(items: KeyedCandidate[]): Promise<number> {
  if (items.length === 0) return 0;
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const p of items) {
      const res = await client.query(
        `INSERT INTO products
           (dedup_key, brand, product_name, producer, beverage_class,
            origin, upc, source, source_ref, source_url, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (dedup_key)
           DO UPDATE SET last_seen_at = now()
         RETURNING (xmax = 0) AS is_insert`,
        [
          p.dedupKey, p.brand ?? null, p.productName ?? null, p.producer ?? null,
          p.beverageClass ?? null, p.origin ?? null, p.upc ?? null,
          p.source, p.sourceRef ?? null, p.sourceUrl ?? null,
          JSON.stringify(p.raw ?? null),
        ],
      );
      if (res.rows[0]?.is_insert) inserted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return inserted;
}

/* ---------------------------------------------------------------------- runs */

interface RunRow {
  run_id: string;
  mode: 'live' | 'test';
  status: RunResult['status'];
  only_sources: string[] | null;
  sources_run: string[];
  candidates: number;
  known_count: number;
  new_products: KeyedCandidate[];
  log: string[];
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function rowToRun(r: RunRow): RunResult {
  return {
    runId: r.run_id,
    mode: r.mode,
    status: r.status,
    onlySources: r.only_sources ?? undefined,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString(),
    finishedAt: r.finished_at?.toISOString(),
    sourcesRun: r.sources_run ?? [],
    candidates: r.candidates,
    knownCount: r.known_count,
    newProducts: r.new_products ?? [],
    log: r.log ?? [],
    error: r.error ?? undefined,
  };
}

const RUN_COLUMNS =
  'run_id, mode, status, only_sources, sources_run, candidates, known_count, ' +
  'new_products, log, error, created_at, started_at, finished_at';

/** Enqueue a run for the worker to pick up. The web layer's only write path. */
export async function enqueueRun(
  mode: 'live' | 'test',
  onlySources?: string[],
): Promise<RunResult> {
  const { rows } = await pool.query<RunRow>(
    `INSERT INTO runs (mode, status, only_sources)
     VALUES ($1, 'queued', $2)
     RETURNING ${RUN_COLUMNS}`,
    [mode, onlySources ?? null],
  );
  return rowToRun(rows[0]!);
}

/** Create an already-running run (used by the CLI, which runs inline). */
export async function createRunningRun(
  mode: 'live' | 'test',
  onlySources?: string[],
): Promise<RunResult> {
  const { rows } = await pool.query<RunRow>(
    `INSERT INTO runs (mode, status, only_sources, started_at, claimed_at)
     VALUES ($1, 'running', $2, now(), now())
     RETURNING ${RUN_COLUMNS}`,
    [mode, onlySources ?? null],
  );
  return rowToRun(rows[0]!);
}

/**
 * Atomically claim the oldest queued run, flipping it to 'running'. Uses
 * FOR UPDATE SKIP LOCKED so multiple workers never grab the same row.
 * Returns null when the queue is empty.
 */
export async function claimNextRun(): Promise<RunResult | null> {
  const { rows } = await pool.query<RunRow>(
    `UPDATE runs SET status = 'running', claimed_at = now(), started_at = now()
       WHERE run_id = (
         SELECT run_id FROM runs
           WHERE status = 'queued'
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
       )
     RETURNING ${RUN_COLUMNS}`,
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

/** Flush the mutable state of a run back to its row (progress + final result). */
export async function saveRun(run: RunResult): Promise<void> {
  await pool.query(
    `UPDATE runs SET
       status       = $2,
       sources_run  = $3,
       candidates   = $4,
       known_count  = $5,
       new_products = $6::jsonb,
       log          = $7::jsonb,
       error        = $8,
       finished_at  = $9
     WHERE run_id = $1`,
    [
      run.runId,
      run.status,
      run.sourcesRun,
      run.candidates,
      run.knownCount,
      JSON.stringify(run.newProducts),
      JSON.stringify(run.log),
      run.error ?? null,
      run.finishedAt ?? null,
    ],
  );
}

export async function getRun(id: string): Promise<RunResult | null> {
  // run_id is a uuid; a malformed id should be a clean miss, not a 500.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pool.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = $1`,
    [id],
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function listRuns(limit = 50): Promise<RunResult[]> {
  const { rows } = await pool.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(rowToRun);
}

/* -------------------------------------------------------------- credentials */

/** Load every source's credentials into one map (sourceId -> {field: value}). */
export async function loadAllCredentials(): Promise<Record<string, Record<string, string>>> {
  const { rows } = await pool.query<{ source_id: string; creds: Record<string, string> }>(
    'SELECT source_id, creds FROM source_credentials',
  );
  const out: Record<string, Record<string, string>> = {};
  for (const r of rows) out[r.source_id] = r.creds ?? {};
  return out;
}

/** Merge new credential values for a source (top-level JSON key merge). */
export async function upsertCredentials(
  sourceId: string,
  creds: Record<string, string>,
): Promise<void> {
  await pool.query(
    `INSERT INTO source_credentials (source_id, creds, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (source_id) DO UPDATE
       SET creds = source_credentials.creds || EXCLUDED.creds,
           updated_at = now()`,
    [sourceId, JSON.stringify(creds)],
  );
}

/* ------------------------------------------------------------- custom sources */

export interface CustomSourceRow {
  id: string;
  label: string;
  kind: 'api' | 'agentic';
  added_from: string;
  analysis: unknown;
}

export async function loadAllCustomSources(): Promise<CustomSourceRow[]> {
  const { rows } = await pool.query<CustomSourceRow>(
    'SELECT id, label, kind, added_from, analysis FROM custom_sources ORDER BY created_at',
  );
  return rows;
}

export async function upsertCustomSource(row: CustomSourceRow): Promise<void> {
  await pool.query(
    `INSERT INTO custom_sources (id, label, kind, added_from, analysis, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (id) DO UPDATE
       SET label = EXCLUDED.label,
           kind = EXCLUDED.kind,
           added_from = EXCLUDED.added_from,
           analysis = EXCLUDED.analysis,
           updated_at = now()`,
    [row.id, row.label, row.kind, row.added_from, JSON.stringify(row.analysis)],
  );
}
