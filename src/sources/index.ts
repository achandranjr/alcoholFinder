import type { Source } from '../types.js';
import { colaCloud } from './colaCloud.js';
import { openBreweryDb } from './openBreweryDb.js';
import { agenticWeb } from './agenticWeb.js';

// COLA Cloud is the primary, authoritative product feed; Open Brewery DB is the
// free, keyless baseline that always runs; the agentic web source covers the
// long tail (producers/importers/distributors without an API). User-added
// sources are loaded from the DB on top at startup — see customSources.ts.
const registry: Source[] = [colaCloud, openBreweryDb, agenticWeb];

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
