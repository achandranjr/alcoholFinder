import { enabledSources } from '../sources/index.js';
import { keyAll, summarize } from '../dedup.js';
import {
  findExistingKeys,
  insertProducts,
  saveRun,
  createRunningRun,
  appendRunLog,
  saveSourceResult,
  loadSourceResults,
} from '../db.js';
import type { RunResult, Source, DiscoveryBudget } from '../types.js';

export interface DiscoverOptions {
  /** Dry run: same flow, reads the DB to decide "new", but writes nothing. */
  test: boolean;
  /** Wall-clock budget. Test mode defaults to ~90s to stay in the 1-2 min window. */
  timeoutMs?: number;
  /** Restrict to specific source ids. Test mode defaults to a small subset. */
  onlySources?: string[];
}

/**
 * Create a run row and run it to completion inline. Used by the CLI. The web
 * layer does NOT use this — it enqueues (db.enqueueRun) and lets the worker
 * pick the run up, because a serverless request can't host a long background job.
 */
export async function discover(opts: DiscoverOptions): Promise<RunResult> {
  const run = await createRunningRun(opts.test ? 'test' : 'live', opts.onlySources);
  await runPipeline(run, opts);
  return run;
}

/**
 * THE discovery flow. Live and test runs are identical except for one thing:
 * a live run persists new products; a test run does not. Both read the DB to
 * determine what counts as "new".
 *
 * Progress is flushed to the run's row (db.saveRun) at each step so the
 * dashboard — which now reads run state from the DB, not process memory — shows
 * live progress while a separate worker executes this.
 */
export async function runPipeline(run: RunResult, opts: DiscoverOptions): Promise<void> {
  const flush = () => saveRun(run);
  const log = (m: string) => { run.log.push(`[${new Date().toISOString()}] ${m}`); };

  run.status = 'running';

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
  await flush();

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
      await flush(); // surface per-source progress to the dashboard
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
    await flush();

    // 4) Persist — LIVE ONLY. Test runs deliberately skip every write to products.
    if (opts.test) {
      log('TEST MODE: skipping all product writes.');
    } else {
      const inserted = await insertProducts(fresh);
      log(`persisted ${inserted} new products`);
    }

    run.status = 'done';
    run.finishedAt = new Date().toISOString();
  } catch (err) {
    run.status = 'error';
    run.error = (err as Error).message;
    run.finishedAt = new Date().toISOString();
    log(`FATAL ${run.error}`);
  } finally {
    await flush();
  }
}

/* --------------------------------------------------------- fan-out / fan-in path

 * The split version of the pipeline above, for the parallel GitHub Actions flow:
 *   gatherOneSource()  -> one per source, run as parallel matrix jobs
 *   aggregateRun()     -> the single overseer job: dedup + ONE write + finalize
 * Each gather job writes only its own source's candidates to run_source_results
 * and never touches `products`; the overseer holds all results until every job
 * has finished (GitHub's `needs:`), then does the single product write.
 * ------------------------------------------------------------------------------ */

function budgetFor(opts: DiscoverOptions): DiscoveryBudget {
  const timeoutMs = opts.timeoutMs ?? (opts.test ? 90_000 : 10 * 60_000);
  return {
    maxCandidates: opts.test ? 8 : 100,
    deadline: Date.now() + timeoutMs,
    test: opts.test,
  };
}

/** One source's gather step (a single parallel matrix job). */
export async function gatherOneSource(
  runId: string,
  sourceId: string,
  opts: DiscoverOptions,
): Promise<void> {
  const src = enabledSources().find((s) => s.id === sourceId);
  if (!src) {
    await saveSourceResult(runId, sourceId, [], 'error', `source not enabled or unknown: ${sourceId}`);
    await appendRunLog(runId, `${sourceId}: ERROR not enabled or unknown`);
    return;
  }
  try {
    const found = await src.discover(budgetFor(opts));
    await saveSourceResult(runId, sourceId, found, 'done', null);
    await appendRunLog(runId, `${sourceId}: ${found.length} candidates`);
  } catch (err) {
    const msg = (err as Error).message;
    await saveSourceResult(runId, sourceId, [], 'error', msg);
    await appendRunLog(runId, `${sourceId}: ERROR ${msg}`);
  }
}

/**
 * The overseer. Runs once after every gather job, even if some failed: it reads
 * whatever each source stored, de-dupes across all of them, does the single
 * existing-key read + single product write (LIVE only), and finalizes the run.
 */
export async function aggregateRun(run: RunResult, opts: DiscoverOptions): Promise<void> {
  const log = (m: string) => run.log.push(`[${new Date().toISOString()}] ${m}`);
  try {
    const results = await loadSourceResults(run.runId);
    run.sourcesRun = results.filter((r) => r.status === 'done').map((r) => r.source);

    const all = results.flatMap((r) => r.candidates);
    // Key once to ask the DB which already exist, then summarize() against that.
    // ponytail: summarize re-keys (one extra O(n) pass on a few hundred rows) —
    // fine at this scale; collapse into one pass if candidate volume explodes.
    const existing = await findExistingKeys(keyAll(all).map((k) => k.dedupKey));
    const { keyed, fresh, knownCount } = summarize(all, existing);
    run.candidates = keyed.length;
    run.newProducts = fresh;
    run.knownCount = knownCount;
    log(`candidates=${keyed.length} new=${fresh.length} known=${knownCount}`);

    if (opts.test) {
      log('TEST MODE: skipping all product writes.');
    } else {
      const inserted = await insertProducts(fresh);
      log(`persisted ${inserted} new products`);
    }

    // Surface any source that failed, but the run as a whole still succeeds.
    const failed = results.filter((r) => r.status === 'error');
    run.status = failed.length === results.length && results.length > 0 ? 'error' : 'done';
    if (failed.length) {
      run.error = `${failed.length} source(s) failed: ${failed.map((r) => r.source).join(', ')}`;
    }
  } catch (err) {
    run.status = 'error';
    run.error = (err as Error).message;
    log(`FATAL ${run.error}`);
  } finally {
    run.finishedAt = new Date().toISOString();
    await saveRun(run);
  }
}
