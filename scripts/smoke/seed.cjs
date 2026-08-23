const { Client } = require('pg');
// Creates the shop.* fixtures the smoke tests expect: a 5M-row table, a composite-PK table, a
// table with no unique key (ctid paging), a view, and comments.
//   SEED_URL=postgres://user:pw@127.0.0.1:5432/ node scripts/smoke/seed.cjs
const U = process.env.SEED_URL ?? 'postgres://sqlmypg@127.0.0.1:5432/';
(async () => {
  let c = new Client(U + 'postgres');
  await c.connect();
  const has = await c.query("SELECT 1 FROM pg_database WHERE datname='demo'");
  if (!has.rowCount) { await c.query('CREATE DATABASE demo'); console.log('created database demo'); }
  else console.log('database demo exists');
  await c.end();

  c = new Client(U + 'demo');
  await c.connect();
  const t0 = Date.now();
  await c.query(`
    CREATE SCHEMA IF NOT EXISTS shop;
    DROP TABLE IF EXISTS shop.events;
    CREATE TABLE shop.events (
      id          bigserial PRIMARY KEY,
      occurred_at timestamptz NOT NULL,
      user_id     bigint NOT NULL,
      kind        text NOT NULL,
      amount      numeric(12,2),
      payload     jsonb,
      note        text
    );
    CREATE TABLE IF NOT EXISTS shop.customers (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email text UNIQUE NOT NULL,
      name text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- composite primary key: exercises the multi-column keyset seek
    CREATE TABLE IF NOT EXISTS shop.line_items (
      order_id bigint NOT NULL,
      line_no  int NOT NULL,
      sku text NOT NULL,
      qty int NOT NULL,
      PRIMARY KEY (order_id, line_no)
    );
    -- no primary key at all: exercises the ctid fallback
    CREATE TABLE IF NOT EXISTS shop.raw_import (
      blob text,
      seen_at timestamptz DEFAULT now()
    );
  `);
  console.log('schema ready');

  await c.query(`
    INSERT INTO shop.events (occurred_at, user_id, kind, amount, payload, note)
    SELECT now() - (g % 2000000) * interval '1 second',
           (g % 50000)::bigint,
           (ARRAY['view','click','purchase','refund','signup'])[1 + g % 5],
           CASE WHEN g % 5 = 2 THEN round((g % 9999)::numeric / 7, 2) END,
           jsonb_build_object('seq', g, 'tag', md5(g::text)),
           CASE WHEN g % 97 = 0 THEN NULL ELSE 'note ' || g END
      FROM generate_series(1, 5000000) g
  `);
  console.log('inserted 5,000,000 events in', ((Date.now() - t0) / 1000).toFixed(1) + 's');

  await c.query(`
    INSERT INTO shop.customers (email, name)
    SELECT 'user' || g || '@example.test', CASE WHEN g % 11 = 0 THEN NULL ELSE 'Customer ' || g END
      FROM generate_series(1, 5000) g
    ON CONFLICT (email) DO NOTHING;
    INSERT INTO shop.line_items (order_id, line_no, sku, qty)
    SELECT g / 3 + 1, 1 + g % 3, 'SKU-' || (g % 500), 1 + g % 7 FROM generate_series(1, 30000) g
    ON CONFLICT DO NOTHING;
    INSERT INTO shop.raw_import (blob) SELECT md5(g::text) FROM generate_series(1, 1000) g;
    CREATE INDEX IF NOT EXISTS events_occurred_at_idx ON shop.events (occurred_at);
    CREATE INDEX IF NOT EXISTS events_user_kind_idx ON shop.events (user_id, kind);
    CREATE OR REPLACE VIEW shop.daily_totals AS
      SELECT date_trunc('day', occurred_at) AS day, kind, count(*) AS n, sum(amount) AS total
        FROM shop.events GROUP BY 1, 2;
    COMMENT ON TABLE shop.events IS 'Synthetic event stream for SqlMyPg testing';
    COMMENT ON COLUMN shop.events.payload IS 'Arbitrary JSON payload';
  `);
  await c.query('ANALYZE shop.events, shop.customers, shop.line_items, shop.raw_import');
  const est = await c.query(`SELECT relname, reltuples::bigint, pg_size_pretty(pg_total_relation_size(oid)) sz
                               FROM pg_class WHERE relnamespace='shop'::regnamespace AND relkind='r' ORDER BY 2 DESC`);
  console.table(est.rows);
  await c.end();
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
