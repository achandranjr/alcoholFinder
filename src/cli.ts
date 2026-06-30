import { discover, gatherOneSource, aggregateRun } from './agent/orchestrator.js';
import { enabledSources } from './sources/index.js';
import { loadCustomSources } from './sources/customSources.js';
import { loadCredentials } from './credentials.js';
import {
  pool,
  getRun,
  createRunningRun,
  markRunStarted,
  appendRunLog,
} from './db.js';

/**
 * CLI for the discovery pipeline. Two flavors:
 *
 *   discover [--test] [--sources=a,b]   inline all-in-one (local dev, one process)
 *
 *   plan | gather | aggregate           the fan-out path the GitHub Actions
 *                                       workflow drives. `plan` resolves the run
 *                                       + the source list (for the job matrix),
 *                                       each `gather` runs ONE source in parallel,
 *                                       and `aggregate` is the single overseer
 *                                       that de-dupes and does the one DB write.
 */

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

async function loadRegistry(): Promise<void> {
  await loadCredentials();
  await loadCustomSources();
}

async function cmdDiscover(): Promise<number> {
  const test = args.includes('--test');
  const srcArg = flag('sources');
  const onlySources = srcArg ? srcArg.split(',') : undefined;

  await loadRegistry();
  console.log(`Starting ${test ? 'TEST (dry-run, no product writes)' : 'LIVE'} discovery...`);
  const run = await discover({ test, onlySources });

  console.log('\n--- log ---');
  for (const line of run.log) console.log(line);
  console.log(`\n--- ${run.newProducts.length} NEW products ---`);
  for (const p of run.newProducts) {
    const name = [p.brand, p.productName].filter(Boolean).join(' — ') || '(unnamed)';
    console.log(`• ${name}  [${p.producer ?? '?'}]  (${p.source})  ${p.sourceUrl ?? ''}`);
  }
  console.log(`\nstatus=${run.status} candidates=${run.candidates} new=${run.newProducts.length} known=${run.knownCount}`);
  return run.status === 'error' ? 1 : 0;
}

/**
 * Resolve a run + its source list, then print {run_id, sources} as JSON on
 * stdout (the workflow feeds it into the gather job's matrix). All human output
 * goes to stderr so stdout stays pure JSON.
 */
async function cmdPlan(): Promise<number> {
  await loadRegistry();
  const sourceArg = flag('source') ?? 'all';
  const mode = flag('mode') === 'test' ? 'test' : 'live';
  let runId = flag('run-id');

  // Attach to a dispatched run row, or create one for a scheduled run.
  if (runId) {
    const run = await getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    await markRunStarted(runId);
  } else {
    const only = sourceArg === 'all' ? undefined : [sourceArg];
    const run = await createRunningRun(mode, only);
    runId = run.runId;
  }

  // Restrict to whatever the run row asked for, intersected with what's enabled
  // right now (a custom source can be disabled if its credentials are missing).
  const run = (await getRun(runId))!;
  const enabledIds = new Set(enabledSources().map((s) => s.id));
  const sources = (run.onlySources ?? [...enabledIds]).filter((id) => enabledIds.has(id));

  await appendRunLog(runId, `plan: mode=${run.mode} sources=[${sources.join(', ')}]`);
  console.error(`planned run ${runId} mode=${run.mode} sources=[${sources.join(', ')}]`);
  process.stdout.write(JSON.stringify({ run_id: runId, sources }));
  return 0;
}

/** Run ONE source (a single matrix job) and stash its candidates. */
async function cmdGather(): Promise<number> {
  await loadRegistry();
  const runId = flag('run-id');
  const source = flag('source');
  if (!runId || !source) throw new Error('gather requires --run-id and --source');
  const run = await getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  await gatherOneSource(runId, source, { test: run.mode === 'test' });
  return 0;
}

/** The overseer: collect every source's results, dedup, write once, finalize. */
async function cmdAggregate(): Promise<number> {
  const runId = flag('run-id');
  if (!runId) throw new Error('aggregate requires --run-id');
  const run = await getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  await aggregateRun(run, { test: run.mode === 'test' });
  console.error(`aggregated run ${runId}: status=${run.status} new=${run.newProducts.length}`);
  return run.status === 'error' ? 1 : 0;
}

async function main(): Promise<void> {
  const handlers: Record<string, () => Promise<number>> = {
    discover: cmdDiscover,
    plan: cmdPlan,
    gather: cmdGather,
    aggregate: cmdAggregate,
  };
  const handler = cmd ? handlers[cmd] : undefined;
  if (!handler) {
    console.error('usage: tsx src/cli.ts <discover [--test] [--sources=a,b] | plan | gather | aggregate> [--run-id=ID] [--source=ID] [--mode=live|test]');
    process.exit(1);
  }
  const code = await handler();
  await pool.end();
  process.exit(code);
}

main().catch((e) => { console.error(e); process.exit(1); });
