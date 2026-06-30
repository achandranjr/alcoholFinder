import assert from 'node:assert/strict';
import { summarize, keyFor } from '../dedup.js';
import type { ProductCandidate } from '../types.js';

/**
 * Self-check for the overseer's pure core: candidates gathered from multiple
 * parallel sources must be de-duped ACROSS sources, then split into new vs known
 * against what's already in the DB. Run with `npm run check`.
 */

const cola = (ttb: string): ProductCandidate => ({
  source: 'cola_cloud', sourceRef: ttb, brand: 'B', productName: 'P', raw: null,
});
const web = (brand: string, name: string): ProductCandidate => ({
  source: 'agentic_web', brand, productName: name, raw: null,
});

// Two sources, with one overlapping COLA record (same TTB id) -> deduped to one.
const all = [cola('111'), cola('111'), cola('222'), web('Acme', 'IPA')];
const existingKey = keyFor(cola('222')); // pretend 222 is already in the DB

const { keyed, fresh, knownCount } = summarize(all, new Set([existingKey]));

assert.equal(keyed.length, 3, 'dups across sources collapse to 3 unique');
assert.equal(knownCount, 1, 'the pre-existing TTB 222 counts as known');
assert.equal(fresh.length, 2, 'the other two are new');
assert.ok(!fresh.some((f) => f.dedupKey === existingKey), 'known item is excluded from new');

// Empty input is a clean no-op (a run where every source errored).
const empty = summarize([], new Set());
assert.deepEqual([empty.keyed.length, empty.fresh.length, empty.knownCount], [0, 0, 0]);

console.log('orchestrator.check: ok');
