import { registerSource } from './index.js';
import { defineApiSource } from './runtime/apiSource.js';
import { defineAgenticSource } from './runtime/agenticSource.js';
import { loadAllCustomSources, upsertCustomSource } from '../db.js';
import type { Source } from '../types.js';
import { sourceAnalysisSchema, type SourceAnalysis } from '../agent/sourceAnalyzer.js';

/**
 * User-added sources are stored as DATA, not generated code: the analyzer's
 * spec is persisted as JSON in the `custom_sources` table and rebuilt into a
 * live Source at runtime via defineApiSource/defineAgenticSource. This replaces
 * the old approach of writing src/sources/custom/<slug>.ts files (impossible on
 * a read-only serverless filesystem, and never reloadable without a redeploy).
 * Credentials are NOT stored here — they live in the source_credentials table.
 */

/** Build a live Source from a stored/just-produced analysis spec. */
export function buildSourceFromAnalysis(a: SourceAnalysis): Source {
  const id = idFor(a.url);
  if (a.kind === 'api') {
    return defineApiSource({ id, label: a.label, addedFrom: a.url, spec: a.api! });
  }
  return defineAgenticSource({
    id,
    label: a.label,
    addedFrom: a.url,
    domains: a.agentic!.domains,
    hint: a.agentic!.hint,
  });
}

/** Persist an analysis, build the Source, and register it live. */
export async function generateAndRegisterSource(analysis: SourceAnalysis): Promise<Source> {
  const source = buildSourceFromAnalysis(analysis);
  await upsertCustomSource({
    id: source.id,
    label: analysis.label,
    kind: analysis.kind,
    added_from: analysis.url,
    analysis,
  });
  registerSource(source);
  return source;
}

/** Load every stored custom source from the DB and register it. */
export async function loadCustomSources(): Promise<void> {
  const rows = await loadAllCustomSources();
  for (const row of rows) {
    try {
      // Validate on the way out — a row written by an older/newer version that
      // no longer matches the schema is skipped rather than crashing startup.
      const analysis = sourceAnalysisSchema.parse(row.analysis);
      registerSource(buildSourceFromAnalysis(analysis));
    } catch (err) {
      console.error(`failed to load custom source ${row.id}: ${(err as Error).message}`);
    }
  }
}

function idFor(url: string): string {
  const slug = new URL(url).hostname
    .replace(/^www\./, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `custom_${slug}`;
}
