# On my way to da liqua sto — autonomous alcohol-product discovery

A TypeScript/Node service that runs agentic discovery passes across multiple
sources to find **new** alcohol products, dedupes them against a **Supabase
Postgres** database, and (on live runs) persists the new ones. Ships with a
dashboard and a **dry-run test mode** that follows the exact same flow but never
writes products.

## Architecture (Vercel + Supabase + worker)

Discovery runs are long-lived (up to ~10 min) and serverless functions can't host
a background job, so the system is split in two halves that share the Supabase DB:

- **Web/API (Vercel):** the dashboard and a thin Express API. It does only fast
  work — it **enqueues** a run (inserts a `queued` row in `runs`) and reads state
  back from Supabase. No discovery happens here. Entry point: `api/index.ts`.
- **Worker (any always-on host — Railway/Render/Fly/a VM):** polls the `runs`
  table, atomically claims a queued run (`FOR UPDATE SKIP LOCKED`), executes the
  pipeline, and flushes progress/log back to the row so the dashboard shows it
  live. Entry point: `src/worker.ts` (`npm run worker`).

All shared state lives in Supabase — runs, per-source credentials, and user-added
source specs — so nothing depends on a local filesystem or process memory.

## Source strategy

The best leading indicator for *new* products is federal label approval — a
product gets a TTB Certificate of Label Approval (COLA) before it can ship
interstate. Sources, in priority order:

| Source | Type | Key? | Notes |
| --- | --- | --- | --- |
| **COLA Cloud** | Product-level API | yes | Enriched TTB COLA registry. ~2,500–3,000 new approvals/week, daily updates. Your primary feed. |
| **Open Brewery DB** | Producer-level API | no | Free worldwide brewery/cidery/brewpub dataset. Seed list for the agent to crawl. |
| **Agentic web** | LLM + web search | Anthropic key | Covers the long tail (individual breweries, importers, distributors with no API) by searching for newly announced products and returning structured candidates. |

Adding a source is a single file implementing the `Source` interface in
`src/sources/` — register it in `src/sources/index.ts`. Good candidates to add:
state liquor-control-board open data, distributor/importer catalogs you have
access to, Untappd (with API approval), and trade-press feeds.

### Adding a source from the dashboard

Paste a URL into the **Sources** panel and hit **Analyze**. An agent (requires
`ANTHROPIC_API_KEY`) reads the site and its API docs and decides how it should
be queried:

- **api** — a documented JSON API exists; the analysis includes the endpoint,
  pagination, a field mapping, and the exact credential fields you must supply.
  The dashboard renders inputs for *only* those fields (one for an API key, two
  for username + password, none for open APIs).
- **agentic** — no usable API; the source is scouted with web search + fetch
  scoped to that site's domains.

Confirming stores the analyzer's spec as a row in the `custom_sources` table and
any credentials in the `source_credentials` table (never in code). At runtime the
spec is rebuilt into a live `Source` via `defineApiSource`/`defineAgenticSource`
in `src/sources/runtime/` — no code is generated and nothing is written to disk,
so it works on a read-only serverless filesystem. The per-source **test** button
dry-runs just that source; the worker reloads custom sources from the DB before
every run, so newly added sources are picked up without a restart.

## Setup

```bash
# 1. Supabase project -> Settings -> Database -> Connection string.
#    Use the "Transaction" POOLER URL (port 6543) for DATABASE_URL.

# 2. Config
cp .env.example .env       # fill in DATABASE_URL; optionally COLACLOUD_API_KEY, ANTHROPIC_API_KEY

# 3. Install (lockfile + no install scripts — see Security below)
npm ci --ignore-scripts    # or: npm install --ignore-scripts

# 4. Create tables — run db/schema.sql once against Supabase.
#    Either paste it into the Supabase SQL editor, or:
npm run db:init            # runs psql "$DATABASE_URL" -f db/schema.sql
```

Sources with missing keys are skipped automatically, so you can start with just
Open Brewery DB (no keys), then add COLA Cloud and an Anthropic key later.

## Running locally

You need **two** processes — the web/API and the worker — plus Supabase:

```bash
npm run server      # dashboard at http://localhost:4317 (enqueues runs only)
npm run worker      # claims queued runs and executes discovery (run separately)

npm run test-run    # CLI: dry-run discovery inline (no product writes)
npm run discover    # CLI: live discovery inline (persists new products)
```

The CLI commands run the pipeline inline and don't need the worker. The dashboard
does: **Run test** enqueues a ~90s dry run and **Run live** enqueues a live run;
the worker picks them up (a run shows `queued · waiting for worker` until it does).

## Deploying (Vercel + Supabase + scheduled GitHub Actions)

For the full step-by-step walkthrough see **[DEPLOY.md](DEPLOY.md)**. In brief:

1. **Supabase** — create the project and run `db/schema.sql` (step 4 above).
2. **Vercel** — import the repo. `vercel.json` already sets the build
   (`npm run build:vercel`, which compiles to `dist/` and serves the dashboard
   from `public/`) and routes `/api/*` to `api/index.ts`. Set the env vars
   (`DATABASE_URL`, and optionally `ANTHROPIC_API_KEY`, `COLACLOUD_API_KEY`) in
   the Vercel project. Note: `/api/sources/analyze` is the one slow endpoint
   (~30–90s); `vercel.json` sets its `maxDuration` to 300s, which Hobby allows
   with Fluid compute (the default) — or add sources via the CLI/DB instead.
3. **Discovery — scheduled (GitHub Actions, free).** Instead of an always-on
   worker, `.github/workflows/discover.yml` runs `npm run discover` (the same
   pipeline, inline via the CLI) on a cron — twice daily, 8 AM and 8 PM US
   Central. Each run still creates a `runs` row and flushes progress to Supabase,
   so the dashboard shows status/history as before. Setup: in the GitHub repo,
   **Settings → Secrets and variables → Actions** add `DATABASE_URL` (required)
   and optionally `ANTHROPIC_API_KEY` and `COLACLOUD_API_KEY`. GitHub cron is
   UTC-only and ignores DST — see the comment in the workflow for the winter
   one-hour shift. Trigger an ad-hoc run anytime via **Actions → Discovery → Run
   workflow**.

   _Alternative — always-on worker:_ deploy this same repo to an always-on host
   (Oracle Cloud Always Free VM, Railway, Render) with the same env vars and
   start command `npm run start:worker` (after `npm run build`) or `npm run
   worker` (tsx, no build step). This is what enables the dashboard's on-demand
   **Run** buttons (the scheduled job above does not service those queued runs).

## How test mode works (the important part)

Live and test runs use the **same** code path (`runPipeline` in
`src/agent/orchestrator.ts`). The only differences:

1. Test mode searches a **small fraction** of services (one fast API source plus
   the agentic source) with tiny per-source budgets and a ~90s deadline.
2. Test mode **reads** the DB to decide what is "new" (`findExistingKeys`) —
   exactly like a live run.
3. Test mode **writes no products**: it never inserts into `products`. (It does
   record its own progress/results in its `runs` row — that's how the dashboard
   shows live status across the separate web and worker processes — but your
   product catalog is untouched.)

So a test run is a faithful rehearsal of a live run that cannot mutate your catalog.

## "New" determination

Every candidate gets a stable `dedup_key` (`src/dedup.ts`): the source's native
id when authoritative (e.g. TTB id), otherwise a hash of normalized
brand + product + producer. A product is "new" iff its key isn't already in the
`products` table. The key is the table's UNIQUE constraint, so live inserts are
idempotent (`ON CONFLICT DO UPDATE last_seen_at`).

## Security notes (re: npm supply-chain worms)

This project keeps a deliberately small dependency tree and is set up to reduce
supply-chain exposure:

- **Install with scripts disabled** — `npm ci --ignore-scripts`. The Shai-Hulud
  worm family executes during package install lifecycle scripts; disabling them
  blocks that vector. None of the runtime deps here need install scripts.
- **Commit the lockfile** and prefer `npm ci` (exact, reproducible) over
  `npm install`.
- **Don't give build/CI runners long-lived cloud or GitHub credentials.** The
  worm harvests exactly those. Use short-lived/scoped tokens.
- **Pin versions** (this `package.json` does) and review updates before bumping.
- Consider `npm audit` and a scanner in CI.

## Layout

```
db/schema.sql              Supabase schema (products, runs, source_credentials, custom_sources)
src/config.ts              env config (zod)
src/types.ts               domain types + Source interface
src/db.ts                  pool (SSL), key lookup + inserts, run queue, creds + custom-source rows
src/dedup.ts               normalization + stable dedup keys
src/credentials.ts         per-source credentials (Supabase-backed, sync read cache)
src/sources/*              connectors (colaCloud, openBreweryDb, agenticWeb)
src/sources/customSources.ts  build/load user-added sources from custom_sources rows
src/agent/orchestrator.ts  the shared discovery flow (live + test), flushes run state to DB
src/worker.ts              polls + claims queued runs and executes them (separate host)
src/cli.ts                 CLI entry (runs the pipeline inline)
src/server/app.ts          Express app (enqueue + reads); exported for Vercel
src/server/index.ts        local listen() wrapper around the app
src/server/public/index.html  dashboard UI
api/index.ts               Vercel serverless entry (exports the Express app)
vercel.json                Vercel build + routing
```
# alcoholFinder
