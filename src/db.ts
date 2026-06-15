import pg from 'pg';
import { config } from './config.js';
import type { KeyedCandidate } from './types.js';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

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

export async function recordLiveRun(r: {
  sourcesRun: string[]; candidates: number; newProducts: number; error?: string;
  startedAt: Date; finishedAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO discovery_runs
       (started_at, finished_at, mode, sources_run, candidates, new_products, error)
     VALUES ($1,$2,'live',$3,$4,$5,$6)`,
    [r.startedAt, r.finishedAt, r.sourcesRun, r.candidates, r.newProducts, r.error ?? null],
  );
}
