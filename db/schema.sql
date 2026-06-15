-- Schema for the alcohol-product discovery service.
-- Run with:  psql "$DATABASE_URL" -f db/schema.sql

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

-- Audit of *persisted* (live) runs only. Test/dry runs are never written here;
-- they live in memory and are surfaced to the dashboard while the process runs.
CREATE TABLE IF NOT EXISTS discovery_runs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    mode            TEXT NOT NULL,           -- 'live' (test runs are not stored)
    sources_run     TEXT[] NOT NULL DEFAULT '{}',
    candidates      INTEGER NOT NULL DEFAULT 0,
    new_products    INTEGER NOT NULL DEFAULT 0,
    error           TEXT
);
