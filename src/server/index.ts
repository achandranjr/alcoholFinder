import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { startDiscovery } from '../agent/orchestrator.js';
import { analyzeSourceUrl, sourceAnalysisSchema } from '../agent/sourceAnalyzer.js';
import { allSources } from '../sources/index.js';
import { generateAndRegisterSource, loadCustomSources } from '../sources/customSources.js';
import { setCredentials } from '../credentials.js';
import { runStore } from '../run-store.js';
import { pool } from '../db.js';

const app = express();
app.use(express.json());

const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, 'public')));

// Kick off a run. Returns immediately with a runId; poll /api/runs/:id.
// Body: { mode?: 'live'|'test', sources?: string[] } — sources restricts the
// run to specific source ids (used by the dashboard's per-source Test button).
app.post('/api/runs', (req, res) => {
  const test = req.body?.mode !== 'live'; // default to safe test mode
  const onlySources =
    Array.isArray(req.body?.sources) && req.body.sources.length > 0
      ? req.body.sources.map(String)
      : undefined;
  const run = startDiscovery({ test, onlySources });
  res.json({ runId: run.runId, mode: run.mode });
});

app.get('/api/runs', (_req, res) => res.json(runStore.list()));

app.get('/api/runs/:id', (req, res) => {
  const run = runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json(run);
});

// All registered sources (built-in + user-added), for the dashboard panel.
// Credential VALUES are never returned — only the field names a source needs.
app.get('/api/sources', (_req, res) => {
  res.json(
    allSources().map((s) => ({
      id: s.id,
      label: s.label,
      enabled: s.enabled(),
      custom: s.meta?.custom ?? false,
      kind: s.meta?.kind,
      url: s.meta?.url,
      credentials: (s.meta?.credentials ?? []).map((c) => ({
        field: c.field,
        label: c.label,
        secret: c.secret ?? false,
        hint: c.hint,
      })),
    })),
  );
});

// Step 1 of adding a source: agentically analyze the URL. Slow (~30-90s) —
// Claude fetches the site and its API docs, then decides api vs agentic and,
// for APIs, which credential fields the user must supply.
app.post('/api/sources/analyze', async (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'invalid URL' });
  }
  try {
    res.json(await analyzeSourceUrl(url));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Step 2: confirm the analysis (echoed back from step 1, possibly with user
// edits) + credentials. Generates src/sources/custom/<slug>.ts, stores the
// credentials in data/credentials.json, and registers the source live.
app.post('/api/sources', async (req, res) => {
  const parsed = sourceAnalysisSchema.safeParse(req.body?.analysis);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid analysis: ${parsed.error.message}` });
  }
  try {
    const source = await generateAndRegisterSource(parsed.data);
    const creds = req.body?.credentials;
    if (creds && typeof creds === 'object' && !Array.isArray(creds)) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(creds as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) clean[k] = v.trim();
      }
      if (Object.keys(clean).length) setCredentials(source.id, clean);
    }
    res.json({ id: source.id, label: source.label, enabled: source.enabled() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Recent persisted products, for dashboard context.
app.get('/api/products', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const { rows } = await pool.query(
    `SELECT brand, product_name, producer, beverage_class, source, source_url, first_seen_at
       FROM products ORDER BY first_seen_at DESC LIMIT $1`,
    [limit],
  );
  res.json(rows);
});

await loadCustomSources();

app.listen(config.PORT, () => {
  console.log(`Dashboard → http://localhost:${config.PORT}`);
});
