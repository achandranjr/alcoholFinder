import { discover } from './agent/orchestrator.js';
import { loadCustomSources } from './sources/customSources.js';
import { loadCredentials } from './credentials.js';
import { pool } from './db.js';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd !== 'discover') {
    console.error('usage: tsx src/cli.ts discover [--test] [--sources=a,b]');
    process.exit(1);
  }

  const test = args.includes('--test');
  const srcArg = args.find((a) => a.startsWith('--sources='));
  const onlySources = srcArg ? srcArg.split('=')[1]!.split(',') : undefined;

  await loadCredentials();
  await loadCustomSources();

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

  await pool.end();
  process.exit(run.status === 'error' ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
