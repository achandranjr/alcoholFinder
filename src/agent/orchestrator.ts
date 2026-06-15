import { enabledSources } from '../sources/index.js';
import { keyAll } from '../dedup.js';
import { findExistingKeys, insertProducts, recordLiveRun } from '../db.js';
import { runStore } from '../run-store.js';
import type { RunResult, Source, DiscoveryBudget } from '../types.js';

export interface DiscoverOptions {
  /** Dry run: same flow, reads the DB to decide "new", but writes nothing. */
  test: boolean;
  /** Wall-clock budget. Test mode defaults to ~90s to stay in the 1-2 min window. */
  timeoutMs?: number;
  /** Restrict to specific source ids. Test mode defaults to a small subset. */
  onlySources?: string[];
}

/** Create a run and launch the pipeline in the background. Returns immediately. */
export function startDiscovery(opts: DiscoverOptions): RunResult {
  const run = runStore.create(opts.test ? 'test' : 'live');
  void runPipeline(run, opts);
  return run;
}

/** Create a run and await full completion. Used by the CLI. */
export async function discover(opts: DiscoverOptions): Promise<RunResult> {
  const run = runStore.create(opts.test ? 'test' : 'live');
  await runPipeline(run, opts);
  return run;
}

/**
 * THE discovery flow. Live and test runs are identical except for one thing:
 * a live run persists new products; a test run does not. Both read the DB to
 * determine what counts as "new".
 */
async function runPipeline(run: RunResult, opts: DiscoverOptions): Promise<void> {
  const startedAt = new Date();
  const log = (m: string) => { run.log.push(`[${new Date().toISOString()}] ${m}`); };

  const timeoutMs = opts.timeoutMs ?? (opts.test ? 90_000 : 10 * 60_000);
  const deadline = Date.now() + timeoutMs;

  // Test mode searches only a small fraction of the services.
  let sources: Source[] = enabledSources();
  if (opts.onlySources) {
    sources = sources.filter((s) => opts.onlySources!.includes(s.id));
  } else if (opts.test) {
    // Smallest meaningful slice: the primary API feed, plus agentic if available.
    const preferred = ['cola_cloud', 'agentic_web'];
    sources = sources.filter((s) => preferred.includes(s.id)).slice(0, 2);
  }

  log(`mode=${run.mode} sources=[${sources.map((s) => s.id).join(', ')}] timeout=${timeoutMs}ms`);

  try {
    // 1) Gather candidates from each source under a per-source budget.
    const perSource = opts.test ? 8 : 100;
    const all = [];
    for (const src of sources) {
      const budget: DiscoveryBudget = { maxCandidates: perSource, deadline, test: opts.test };
      try {
        const found = await src.discover(budget);
        log(`${src.id}: ${found.length} candidates`);
        run.sourcesRun.push(src.id);
        all.push(...found);
      } catch (err) {
        log(`${src.id}: ERROR ${(err as Error).message}`);
      }
    }

    // 2) Normalize + key (also de-dupes within the run).
    const keyed = keyAll(all);
    run.candidates = keyed.length;

    // 3) Ask the DB which keys already exist — the "new" determination.
    //    This read happens in BOTH modes.
    const existing = await findExistingKeys(keyed.map((k) => k.dedupKey));
    const fresh = keyed.filter((k) => !existing.has(k.dedupKey));
    run.newProducts = fresh;
    run.knownCount = keyed.length - fresh.length;
    log(`candidates=${keyed.length} new=${fresh.length} known=${run.knownCount}`);

    // 4) Persist — LIVE ONLY. Test runs deliberately skip every write.
    if (opts.test) {
      log('TEST MODE: skipping all DB writes.');
    } else {
      const inserted = await insertProducts(fresh);
      log(`persisted ${inserted} new products`);
      await recordLiveRun({
        sourcesRun: run.sourcesRun,
        candidates: run.candidates,
        newProducts: fresh.length,
        startedAt,
        finishedAt: new Date(),
      });
    }

    run.status = 'done';
    run.finishedAt = new Date().toISOString();
  } catch (err) {
    run.status = 'error';
    run.error = (err as Error).message;
    run.finishedAt = new Date().toISOString();
    log(`FATAL ${run.error}`);
  }
}