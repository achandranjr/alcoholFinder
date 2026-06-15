# Still & Cellar — autonomous alcohol-product discovery

A TypeScript/Node service that runs agentic discovery passes across multiple
sources to find **new** alcohol products, dedupes them against a local Postgres
database, and (on live runs) persists the new ones. Ships with a dashboard and a
**dry-run test mode** that follows the exact same flow but writes nothing.

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

Confirming generates `src/sources/custom/<slug>.ts` (a declarative wrapper over
`defineApiSource`/`defineAgenticSource` in `src/sources/runtime/`), stores any
credentials in `data/credentials.json` (gitignored, never in code), and
registers the source live — the per-source **test** button dry-runs just that
source. Generated sources are reloaded on startup.

## Setup

```bash
# 1. Postgres (local)
createdb alcohol_discovery

# 2. Config
cp .env.example .env       # fill in DATABASE_URL; optionally COLACLOUD_API_KEY, ANTHROPIC_API_KEY

# 3. Install (lockfile + no install scripts — see Security below)
npm ci --ignore-scripts    # or: npm install --ignore-scripts

# 4. Create tables
npm run db:init
```

Sources with missing keys are skipped automatically, so you can start with just
Open Brewery DB (no keys), then add COLA Cloud and an Anthropic key later.

## Running

```bash
npm run server      # dashboard at http://localhost:4317
npm run test-run    # CLI: dry-run discovery (no DB writes)
npm run discover    # CLI: live discovery (persists new products)
```

From the dashboard, **Run test** does a ~90s dry run; **Run live** writes new
products (with a confirm prompt).

## How test mode works (the important part)

Live and test runs use the **same** code path (`runPipeline` in
`src/agent/orchestrator.ts`). The only differences:

1. Test mode searches a **small fraction** of services (one fast API source plus
   the agentic source) with tiny per-source budgets and a ~90s deadline.
2. Test mode **reads** the DB to decide what is "new" (`findExistingKeys`) —
   exactly like a live run.
3. Test mode **writes nothing**: no `products`, no `discovery_runs`. Its results
   live only in an in-memory store and are shown live on the dashboard.

So a test run is a faithful rehearsal of a live run that cannot mutate your data.

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
db/schema.sql              Postgres schema (products, discovery_runs)
src/config.ts              env config (zod)
src/types.ts               domain types + Source interface
src/db.ts                  pool, existing-key lookup, inserts
src/dedup.ts               normalization + stable dedup keys
src/sources/*              connectors (colaCloud, openBreweryDb, agenticWeb)
src/agent/orchestrator.ts  the shared discovery flow (live + test)
src/run-store.ts           in-memory run results (home of test runs)
src/cli.ts                 CLI entry
src/server/index.ts        Express API + static dashboard
src/server/public/index.html  dashboard UI
```
# alcoholFinder
