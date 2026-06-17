import { claimNextRun, pool } from './db.js';
import { runPipeline } from './agent/orchestrator.js';
import { loadCredentials } from './credentials.js';
import { loadCustomSources } from './sources/customSources.js';

/**
 * The discovery worker. Runs on any always-on host (Railway, Render, Fly, a VM
 * — NOT Vercel serverless, which can't host a long background job). It polls the
 * `runs` table for queued runs, claims one atomically, executes the pipeline,
 * and flushes progress back to the row so the Vercel-hosted dashboard can show
 * it live. This is the half of the system that does the slow, long-running work.
 */

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 3000);

let stopping = false;

async function processOne(): Promise<boolean> {
  const run = await claimNextRun();
  if (!run) return false;

  console.log(`[worker] claimed run ${run.runId} (mode=${run.mode})`);
  // Refresh credentials + user-added sources from the DB so runs pick up
  // anything added via the dashboard since the worker started — no restart.
  await loadCredentials();
  await loadCustomSources();

  try {
    await runPipeline(run, { test: run.mode === 'test', onlySources: run.onlySources });
    console.log(`[worker] finished run ${run.runId}: status=${run.status} new=${run.newProducts.length}`);
  } catch (err) {
    // runPipeline already records pipeline errors on the row; this guards
    // against anything thrown outside it so the loop keeps going.
    console.error(`[worker] run ${run.runId} crashed: ${(err as Error).message}`);
  }
  return true;
}

async function loop(): Promise<void> {
  console.log(`[worker] polling for queued runs every ${POLL_MS}ms`);
  while (!stopping) {
    let didWork = false;
    try {
      didWork = await processOne();
    } catch (err) {
      // Transient DB/claim errors shouldn't kill the worker.
      console.error(`[worker] poll error: ${(err as Error).message}`);
    }
    // Drain the queue back-to-back; only sleep when there's nothing to do.
    if (!didWork) await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received, shutting down after current run`);
    stopping = true;
  });
}

loop()
  .catch((err) => {
    console.error('[worker] fatal:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
