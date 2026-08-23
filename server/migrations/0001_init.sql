-- SqlMyPg application metadata. Applied by src/db/migrate.ts, which supplies the transaction.

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text,
  password_hash text,
  provider text NOT NULL DEFAULT 'local',
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS connections (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 5432,
  database text NOT NULL,
  db_user text NOT NULL,
  password_enc text,
  ssl_mode text NOT NULL DEFAULT 'prefer',
  color text,
  read_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connections_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS connections_owner_id_name_unique ON connections (owner_id, name);

-- connection_id is intentionally not a foreign key: history outlives a deleted connection.
CREATE TABLE IF NOT EXISTS query_history (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  connection_id text,
  connection_name text NOT NULL,
  sql text NOT NULL,
  duration_ms integer,
  row_count bigint,
  error text,
  ran_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT query_history_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS query_history_user_id_ran_at_idx ON query_history (user_id, ran_at DESC);

CREATE TABLE IF NOT EXISTS saved_queries (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  sql text NOT NULL,
  connection_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_queries_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS saved_queries_owner_id_name_unique ON saved_queries (owner_id, name);
