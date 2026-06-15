import { createHash } from 'node:crypto';
import type { ProductCandidate, KeyedCandidate } from './types.js';

function norm(s?: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Compute a stable identity for a candidate.
 *  - If the source has an authoritative native id (e.g. TTB COLA id), prefer it.
 *  - Otherwise hash the normalized brand + product + producer.
 * This key is what the DB stores as UNIQUE, and what we compare against to
 * decide whether a discovered product is "new".
 */
export function keyFor(c: ProductCandidate): string {
  // Authoritative native ids: the built-in registries, plus user-added API
  // connectors (custom_*) whose fieldMap mapped a stable record id.
  if (
    c.sourceRef &&
    (c.source === 'cola_cloud' || c.source === 'open_brewery_db' || c.source.startsWith('custom_'))
  ) {
    return `${c.source}:${c.sourceRef}`;
  }
  const basis = [norm(c.brand), norm(c.productName), norm(c.producer)]
    .filter(Boolean)
    .join('|');
  const hash = createHash('sha1').update(basis).digest('hex').slice(0, 16);
  return `hash:${hash}`;
}

export function keyAll(candidates: ProductCandidate[]): KeyedCandidate[] {
  // De-duplicate within a single run too (sources can overlap).
  const seen = new Map<string, KeyedCandidate>();
  for (const c of candidates) {
    const dedupKey = keyFor(c);
    if (!seen.has(dedupKey)) seen.set(dedupKey, { ...c, dedupKey });
  }
  return [...seen.values()];
}
