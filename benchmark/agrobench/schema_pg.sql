-- PostgreSQL schema for the benchmark stand (spec §13.2). Bigint keys throughout (rather than the
-- main app's uuid keys), for direct comparability with Redis's numeric ids. load_pg.py splits
-- this file at the INDEXES marker below: tables are created first, all four CSVs are loaded via
-- COPY, and only then do the indexes get built and ANALYZE run (spec §13.4 — never index before a
-- bulk COPY).

CREATE TABLE organizations (
  id bigint PRIMARY KEY,
  type varchar(16) NOT NULL CHECK (type IN ('FARM','PROCESSOR','LAB','RETAILER','AUTHORITY')),
  name varchar(255) NOT NULL,
  inn varchar(12) NOT NULL,
  region_code varchar(8) NOT NULL,
  trust_rating integer CHECK (trust_rating BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL
);

CREATE TABLE batches (
  id bigint PRIMARY KEY,
  public_code varchar(32) NOT NULL,
  product varchar(160) NOT NULL,
  origin_org_id bigint NOT NULL REFERENCES organizations(id),
  holder_org_id bigint NOT NULL REFERENCES organizations(id),
  kind varchar(8) NOT NULL CHECK (kind IN ('RAW','DERIVED')),
  mass_kg numeric(12,3) NOT NULL CHECK (mass_kg > 0),
  status varchar(16) NOT NULL CHECK (status IN
    ('Created','OnTest','Approved','InTransit','Accepted','Processed','OnSale','Sold','Blocked','Recalled','WrittenOff')),
  harvested_at timestamptz NOT NULL,
  -- Optimistic locking for W3, "смена статуса с проверкой version" (spec §13.5).
  version integer NOT NULL DEFAULT 1
);

-- No surrogate id: (parent_id, child_id) is the natural key, matching Redis's link:{parent}:{child}.
CREATE TABLE batch_links (
  parent_id bigint NOT NULL REFERENCES batches(id),
  child_id bigint NOT NULL REFERENCES batches(id),
  mass_used_kg numeric(12,3) NOT NULL CHECK (mass_used_kg > 0),
  link_type varchar(16) NOT NULL CHECK (link_type IN ('PROCESSING','REPACKAGE','MIX')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (parent_id, child_id),
  CHECK (parent_id <> child_id)
);

CREATE TABLE lab_tests (
  id bigint PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES batches(id),
  lab_org_id bigint NOT NULL REFERENCES organizations(id),
  reason varchar(16) NOT NULL CHECK (reason IN ('PLANNED','RISK','COMPLAINT','INSPECTOR')),
  conclusion varchar(8) NOT NULL CHECK (conclusion IN ('PASS','FAIL')),
  value numeric(14,4) NOT NULL,
  due_at timestamptz NOT NULL
);

-- === INDEXES (created after COPY + ANALYZE) ===

CREATE UNIQUE INDEX ux_batches_public_code ON batches(public_code);
-- Covering index for R3: holder's batches of a given status, newest first, 50 rows (spec §13.2/§13.5).
CREATE INDEX ix_batches_holder_status_harvested ON batches(holder_org_id, status, harvested_at DESC)
  INCLUDE (public_code, mass_kg);
CREATE INDEX ix_batch_links_parent ON batch_links(parent_id);
CREATE INDEX ix_batch_links_child ON batch_links(child_id);
CREATE INDEX ix_lab_tests_batch ON lab_tests(batch_id);
CREATE INDEX ix_lab_tests_due ON lab_tests(due_at);
