import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeSourceUrl, sourceAnalysisSchema } from '../agent/sourceAnalyzer.js';
import { allSources } from '../sources/index.js';
import { generateAndRegisterSource, loadCustomSources } from '../sources/customSources.js';
import { setCredentials, loadCredentials } from '../credentials.js';
import { enqueueRun, getRun, listRuns, pool } from '../db.js';
import { config, has } from '../config.js';

/**
 * The web/API layer. This runs on Vercel (and locally), so it must do ONLY fast
 * work: it enqueues runs and reads state from Postgres/Supabase. The actual
 * discovery is executed by the separate worker (src/worker.ts). There is no
 * background job here — a serverless function can't keep one alive.
 */

// One-time, lazily-awaited init. On serverless each cold start runs this once,
// on the first request, to load credentials + user-added sources from the DB.
let initPromise: Promise<void> | null = null;
function init(): Promise<void> {
  return (initPromise ??= (async () => {
    await loadCredentials();
    await loadCustomSources();
  })());
}

// Trigger the discovery workflow via GitHub's workflow_dispatch API. Inputs are
// always strings (a workflow_dispatch constraint). Succeeds on 204 No Content.
async function dispatchWorkflow(inputs: { run_id: string; source: string; mode: string }): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${config.GITHUB_REPO}/actions/workflows/discover.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: config.GITHUB_REF, inputs }),
    },
  );
  if (!res.ok) {
    throw new Error(`workflow_dispatch failed ${res.status}: ${await res.text().catch(() => '')}`);
  }
}

const app = express();
app.use(express.json());

// Ensure the source registry + credential cache are populated before any route.
app.use((_req, _res, next) => {
  init().then(() => next()).catch(next);
});

// Static dashboard, for non-Vercel hosts (local dev, the worker host, etc.).
// On Vercel the dashboard is served as a static asset (see vercel.json); this
// path simply won't exist in the function bundle, and express.static no-ops.
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, 'public')));

// Enqueue a run. Returns immediately with a runId; the worker picks it up and
// the client polls /api/runs/:id. Body: { mode?: 'live'|'test', sources?: [] }.
app.post('/api/runs', async (req, res, next) => {
  try {
    const mode = req.body?.mode === 'live' ? 'live' : 'test'; // default to safe test mode
    const onlySources =
      Array.isArray(req.body?.sources) && req.body.sources.length > 0
        ? req.body.sources.map(String)
        : undefined;
    const run = await enqueueRun(mode, onlySources);
    res.json({ runId: run.runId, mode: run.mode, status: run.status });
  } catch (err) {
    next(err);
  }
});

// On-demand run from the dashboard. Enqueues a run row (so the dashboard can
// poll it), then asks GitHub to dispatch the discovery workflow for that run —
// `source` may be a single source id or "all". The actual work happens in the
// parallel GitHub Actions jobs, not here. Body: { source?, mode?: 'live'|'test' }.
app.post('/api/runs/dispatch', async (req, res, next) => {
  try {
    if (!has.githubDispatch()) {
      return res.status(503).json({
        error: 'on-demand runs are not configured: set GITHUB_TOKEN and GITHUB_REPO',
      });
    }
    const mode = req.body?.mode === 'live' ? 'live' : 'test'; // default to safe test mode
    const source = String(req.body?.source ?? 'all').trim() || 'all';
    const onlySources = source === 'all' ? undefined : [source];

    const run = await enqueueRun(mode, onlySources);
    await dispatchWorkflow({ run_id: run.runId, source, mode });
    res.json({ runId: run.runId, mode: run.mode, status: run.status });
  } catch (err) {
    next(err);
  }
});

app.get('/api/runs', async (_req, res, next) => {
  try {
    res.json(await listRuns());
  } catch (err) {
    next(err);
  }
});

app.get('/api/runs/:id', async (req, res, next) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run);
  } catch (err) {
    next(err);
  }
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
// for APIs, which credential fields the user must supply. NOTE: this is the one
// slow endpoint; on Vercel it needs a high function maxDuration (see vercel.json).
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
// edits) + credentials. Stores the source spec in custom_sources, the
// credentials in source_credentials, and registers the source live.
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
      if (Object.keys(clean).length) await setCredentials(source.id, clean);
    }
    res.json({ id: source.id, label: source.label, enabled: source.enabled() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Recent persisted products, for dashboard context.
app.get('/api/products', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const { rows } = await pool.query(
      `SELECT brand, product_name, producer, beverage_class, source, source_url, first_seen_at
         FROM products ORDER BY first_seen_at DESC LIMIT $1`,
      [limit],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// JSON error handler so failures return a clean body instead of an HTML stack.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: (err as Error)?.message ?? 'internal error' });
});

export { app, init };
export default app;
