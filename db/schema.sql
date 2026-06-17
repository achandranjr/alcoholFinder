-- Schema for the alcohol-product discovery service (Supabase / Postgres).
-- Run it once against your Supabase database, either:
--   psql "$DATABASE_URL" -f db/schema.sql
-- or by pasting this file into the Supabase SQL editor.
--
-- gen_random_uuid() comes from pgcrypto, which Supabase enables by default.
-- The line below is a no-op there but keeps a plain Postgres install happy too.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS products (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Stable identity used to decide whether a discovered product is "new".
    -- For COLA records this is the TTB id; otherwise a hash of normalized fields.
    dedup_key       TEXT NOT NULL UNIQUE,

    brand           TEXT,
    product_name    TEXT,
    producer        TEXT,            -- winery / brewery / distillery / importer
    beverage_class  TEXT,            -- e.g. 'malt beverage', 'wine', 'distilled spirits'
    origin          TEXT,            -- country / state of origin if known
    upc             TEXT,            -- barcode if extracted

    source          TEXT NOT NULL,   -- which connector found it (e.g. 'cola_cloud')
    source_ref      TEXT,            -- source-native id (e.g. TTB id, brewery id)
    source_url      TEXT,            -- link back to the record
    raw             JSONB,           -- full normalized payload from the source

    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_source       ON products (source);
CREATE INDEX IF NOT EXISTS idx_products_first_seen   ON products (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_brand        ON products (lower(brand));

-- Runs. This is the single source of truth for run state, shared between the
-- web layer (which only ENQUEUES runs) and the worker (which claims and runs
-- them). It replaces the old in-process run store, so both live AND test runs
-- get a row here. The test-mode invariant is unchanged: a test run still never
-- writes to `products` — it just records its own progress in this row.
CREATE TABLE IF NOT EXISTS runs (
    run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mode            TEXT NOT NULL CHECK (mode IN ('live', 'test')),
    -- queued -> running -> done|error. The worker claims 'queued' rows.
    status          TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'done', 'error')),
    only_sources    TEXT[],                  -- restrict to these source ids (per-source test)
    sources_run     TEXT[] NOT NULL DEFAULT '{}',
    candidates      INTEGER NOT NULL DEFAULT 0,
    known_count     INTEGER NOT NULL DEFAULT 0,
    new_products    JSONB NOT NULL DEFAULT '[]',   -- the new KeyedCandidates, for the dashboard
    log             JSONB NOT NULL DEFAULT '[]',   -- human-readable progress lines
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- enqueued at
    claimed_at      TIMESTAMPTZ,                         -- when a worker picked it up
    started_at      TIMESTAMPTZ,                         -- when the pipeline began
    finished_at     TIMESTAMPTZ
);

-- The worker dequeue path: oldest queued first.
CREATE INDEX IF NOT EXISTS idx_runs_queued  ON runs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at DESC);

-- Per-source credentials for user-added sources. Replaces data/credentials.json
-- (no filesystem writes on serverless). Values are stored as a JSON object of
-- { [field]: value }; field NAMES are public, values are secret.
CREATE TABLE IF NOT EXISTS source_credentials (
    source_id   TEXT PRIMARY KEY,
    creds       JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User-added sources. Replaces the generated src/sources/custom/<slug>.ts files
-- (no runtime code generation on serverless). We store the analyzer's spec as
-- JSON and rebuild the Source at runtime via defineApiSource/defineAgenticSource.
CREATE TABLE IF NOT EXISTS custom_sources (
    id          TEXT PRIMARY KEY,            -- e.g. 'custom_example_com'
    label       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('api', 'agentic')),
    added_from  TEXT NOT NULL,               -- the URL the user submitted
    analysis    JSONB NOT NULL,              -- full SourceAnalysis from the analyzer
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
