import type { Source } from '../types.js';
import { colaCloud } from './colaCloud.js';
import { agenticWeb } from './agenticWeb.js';

// COLA Cloud is the primary, authoritative product feed; the agentic web source
// covers the long tail (producers/importers/distributors without an API).
// User-added sources (src/sources/custom/) are registered on top at startup —
// see customSources.ts.
const registry: Source[] = [colaCloud, agenticWeb];

export function allSources(): Source[] {
  return [...registry];
}

export function enabledSources(): Source[] {
  return registry.filter((s) => s.enabled());
}

/** Add a source, replacing any existing one with the same id. */
export function registerSource(source: Source): void {
  const i = registry.findIndex((s) => s.id === source.id);
  if (i >= 0) registry[i] = source;
  else registry.push(source);
}
