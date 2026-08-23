# SqlMyPg

[![CI](https://github.com/xAL95/SqlMyPg/actions/workflows/ci.yml/badge.svg)](https://github.com/xAL95/SqlMyPg/actions/workflows/ci.yml)

A web UI for PostgreSQL in the phpMyAdmin class: browse schemas, run SQL, page through
tables, export results. Built for instances where a table has a billion rows, so nothing in
it counts rows, offsets pages, or buffers a whole result set.

## The one idea

**A query session is pinned to one Postgres backend for its whole life.** Every editor tab
owns a session, and a session owns a single `pg.Client`, not a pool checkout. Nothing else
ever runs on that connection.

That is what makes this script behave exactly the way it does in `psql`:

```sql
BEGIN;

CREATE TEMP TABLE suspects AS
SELECT id FROM events WHERE created_at > now() - interval '1 day';

SELECT count(*) FROM suspects;          -- the temp table is visible: same backend
SET LOCAL work_mem = '256MB';           -- and this setting sticks for the transaction

DELETE FROM events WHERE id IN (SELECT id FROM suspects);

ROLLBACK;                               -- nothing happened, and the temp table is gone
```

On a pooled connection the second statement would land on a different backend and fail with
`relation "suspects" does not exist`. Advisory locks, `SET`, cursors, `LISTEN`, prepared
statements and `pg_temp` all work here for the same reason. The tab's transaction status
(`idle` / `in_transaction` / `failed`) is the real backend's status, and cancelling a query
sends `pg_cancel_backend` to the pid the session reported.

The cost is honest and stated in [Limitations](#limitations): a session holds a real backend
open until you close the tab or it idles out, so sessions per user are capped.

## What it does

**Browse and read**

- Schema tree over tables, views, materialised views, foreign tables and functions, with row
  and size estimates from the planner, never `COUNT(*)`.
- Virtualised result grid with column resize and auto-fit, click-to-sort headers, cell and
  rectangle selection, `Ctrl`-click for non-contiguous rows, and copy as TSV, CSV or `INSERT`.
- Keyset pagination: the next page seeks from the last row's key, so page 10 000 of a
  billion-row table is as fast as page 1.
- `Ctrl` + `P` opens one field that searches tables, connections and commands together.

**Write**

- Insert a row, edit a single cell, delete selected rows. Each one is addressed by the
  relation's primary key or unique index, never by position or `ctid`.
- Cells are editable in a query result too, not just when browsing a table: a result column
  carries the oid of the table it came from, so a cell can be written back when it maps to a
  stored column of an ordinary table whose whole key is in the `SELECT`. Where it cannot, the
  grid says why, and names the column to add.
- `CREATE TABLE` and the whole `ALTER` family are built in dialogs that write the statement
  into a query tab, so you read it and your own session runs it. Only `TRUNCATE` and
  `DROP TABLE` execute directly, behind a confirmation.

**Operate**

- Database roles and privileges: role attributes, memberships, and a matrix of who holds what
  on a table or schema, which distinguishes a privilege granted here from one inherited
  through membership or ownership. Cluster-wide changes are written into a query tab rather
  than executed.
- Application user accounts, local password or OIDC, with the first account bootstrapping the
  admin.
- Per-connection read-only mode, a colour tag, and `sslMode` up to `verify-full`.
- Query history and saved queries, both live: history refreshes the moment a statement is
  recorded. Passwords in DDL are redacted before history is stored.
- `EXPLAIN (ANALYZE, FORMAT JSON)` as a collapsible tree with timings.
- Export via `COPY … TO STDOUT`, streamed to the response on its own connection.
- Light and dark, switched at runtime.

## Architecture

```
shared/protocol.d.ts   frozen wire contract, types only, imported by both sides
server/src             Fastify app: auth, connections, sessions, exec, browse, introspect, export
server/migrations      SQL migrations for the metadata database, applied on boot
web/src                React 19 + Vite UI: Monaco editor, virtualised result grid, schema tree
scripts                setup-wsl-pg.sh (WSL Postgres setup), dev.md (cheat sheet), smoke/
```

Two Postgres roles in your head, kept strictly apart:

- **metadata database** (`APP_DATABASE_URL`). SqlMyPg's own storage: users, saved
  connections, query history, saved queries. Owned by the app, migrated by the app.
- **target databases**. The servers you registered in the UI. SqlMyPg only ever runs the
  SQL you typed against them.

The request path for running a statement:

```
browser tab
  └─ sessionId (created once per tab, held in the tab's state)
       └─ POST /api/sessions/:id/exec        Fastify route, zod-validated body
            └─ session registry lookup       -> one pinned pg.Client, one backend pid
                 └─ statements run in order on that client
                      └─ WS /ws pushes exec-start, stmt-start, stmt-end, notice, exec-end
```

The HTTP response carries the materialised rows (`ExecResponse`); the WebSocket carries
progress for statements that are still running, plus `NOTICE`/`WARNING` output from the
server as it arrives. Both shapes live in `shared/protocol.d.ts` and neither side invents
fields.

## How large results are handled

| Problem | What SqlMyPg does |
| --- | --- |
| `SELECT * FROM billion_row_table` | Materialises `DEFAULT_MAX_ROWS` (1000) rows, leaves the rest behind a **server-side cursor** on the pinned connection. The result is marked `truncated` with a `cursorId`; the grid fetches more in batches as you scroll. |
| Row counts | **Planner estimates** (`pg_class.reltuples`, and the estimate from the query plan), never `COUNT(*)`. The UI shows them as approximate. |
| Paging a table | **Keyset pagination**: order by the primary key (or `ctid` if there is none) and seek past the last row's key. No `OFFSET`, so page 100000 costs the same as page 1. |
| Export | `COPY (...) TO STDOUT` streamed straight to the HTTP response, so a 40 GB CSV never lands in server memory. |
| Rendering | The grid is **virtualised**: only the visible window of rows and columns is in the DOM. |
| A query that will not end | `statement_timeout` on every session (`DEFAULT_STATEMENT_TIMEOUT_MS`), plus explicit cancel via the session's backend pid. |

## Quick start (Windows + WSL)

This is the primary development path. Verified against: Windows 11, Node 22.22, npm 11,
WSL2 `Ubuntu-26.04` with PostgreSQL 18.4.

**1. Make WSL's Postgres reachable from Windows.** A stock Ubuntu cluster listens on the
unix socket only (`/var/run/postgresql/.s.PGSQL.5432`), so a dev server running on Windows
cannot connect to it at all, and there is no role named after your Windows user. The setup
script fixes both. Look before you leap:

```powershell
# WSL reaches Windows drives under /mnt/<drive>. Run this from the repo root and it derives the
# path to your own checkout, whatever it is called.
$repo = wsl wslpath -a ((Get-Location).Path -replace '\\', '/')

wsl -d Ubuntu-26.04 -- sudo sh "$repo/scripts/setup-wsl-pg.sh" --dry-run
wsl -d Ubuntu-26.04 -- sudo sh "$repo/scripts/setup-wsl-pg.sh"
```

Swap `Ubuntu-26.04` for your own distro. `wsl -l -q` lists them.

It is idempotent and prints every change. It adds a `conf.d` drop-in with
`listen_addresses = 'localhost'` (WSL2 forwards Windows' localhost into the distro, so
that is enough), appends a `scram-sha-256` host line for `127.0.0.1/32` and `::1/128` to
`pg_hba.conf` only if one is missing (after a timestamped backup), creates the `sqlmypg`
role and database, restarts the cluster, verifies with `pg_isready` and a real login, and
prints the `APP_DATABASE_URL` line to paste next. Pass your own password with
`sudo SQLMYPG_PASSWORD=... sh ...` instead of letting it generate one.

**2. Configure.**

```powershell
copy .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Put that value in `APP_SECRET` and the URL from step 1 in `APP_DATABASE_URL`.

**3. Install and create the metadata schema.**

```powershell
npm install
npm run db:push
```

`db:push` is optional; the server also applies pending migrations from
`server/migrations` on boot. It is here so a failure is a clear error now instead of a
confusing one later.

**4. Run it.**

```powershell
npm run dev          # Fastify on http://127.0.0.1:5274, Vite on http://localhost:5273
```

Vite proxies `/api` and `/ws` to 5274. `npm run dev:server` and `npm run dev:web` run them
separately if you want the logs in their own terminals.

**5. Open <http://localhost:5273>.** No user exists yet, so the app offers a signup form;
the first account created becomes the admin. Then add a connection. For the WSL cluster
that is host `127.0.0.1`, port `5432`, user `sqlmypg`, ssl mode `disable`.

Health check for scripts and containers: `GET /api/health` on port 5274.

If requests suddenly start failing with `ECONNREFUSED 127.0.0.1:5432` after everything was
working, WSL shut the distro down and took PostgreSQL with it. Any `wsl` command brings it
back; see the last section of `scripts/dev.md`.

## Verification

There is no test framework. There are three runnable checks, described in `scripts/dev.md`:

| Check | What it covers |
| --- | --- |
| `npm test` | The SQL statement splitter, against the hazards that actually break naive splitters: semicolons inside strings, dollar-quoted bodies with nested tags, line and nested block comments, quoted identifiers, statement offsets. |
| `node scripts/smoke/api.mjs` | The whole API against a real PostgreSQL: the `BEGIN`/temp table/`ROLLBACK` script, transaction status transitions, temp tables surviving between requests, cursor paging over 5M rows, cancellation, keyset paging including composite keys and the `ctid` fallback, `COPY` export, read-only sessions, WebSocket streaming, session teardown. |
| `node scripts/smoke/ui.mjs` | The real browser: renders, signs in, walks the catalog, runs SQL in a session, shows the transaction badge and SQL errors, browses a 5M-row table, and fails on any console error. |

`scripts/smoke/seed.cjs` builds the fixtures the last two expect.

## Docker (optional)

Docker is not installed on this machine, so this path is untested here and is not the dev
flow. It exists for deployment.

```bash
APP_SECRET=$(openssl rand -base64 32) docker compose up --build
# then open http://localhost:5274
```

`docker-compose.yml` runs exactly two services: `postgres:18-alpine` with a named volume
and a `pg_isready` healthcheck, and the app built from the `Dockerfile`, started only once
the database is healthy. Replace `CHANGE_ME_DB_PASSWORD` in both places before using it
anywhere real. The `Dockerfile` is a multi-stage `node:22-alpine` build: install, build
server (`tsc`) and web (`vite build`), then a final image with only `server/dist`,
`server/migrations`, `web/dist` and production `node_modules`, running as the unprivileged
`node` user with `WEB_DIST=/app/web/dist` so Fastify serves the UI itself on 5274.

## Environment variables

Every variable the server reads. `.env.example` is the same list with the defaults filled in.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables static file serving and secure defaults. |
| `HOST` | `127.0.0.1` | Bind address. `0.0.0.0` in a container. |
| `PORT` | `5274` | HTTP + WebSocket port. |
| `APP_DATABASE_URL` | — | Metadata database. Required. |
| `APP_SECRET` | — | Signs session cookies, encrypts stored connection passwords. Required. Changing it logs everyone out and orphans stored passwords. |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | How long an unused **query session** is kept before it is reaped and its backend released (30 min). Also the `idle_in_transaction_session_timeout` on every session, so an abandoned tab cannot hold locks forever. Not the login cookie lifetime, which is 30 days. |
| `SESSION_MAX_PER_USER` | `10` | Concurrent pinned query sessions per user. Each holds one Postgres backend. |
| `DEFAULT_STATEMENT_TIMEOUT_MS` | `30000` | `statement_timeout` for new sessions. `0` disables. |
| `DEFAULT_MAX_ROWS` | `1000` | Rows materialised per statement before the cursor takes over. |
| `MAX_MAX_ROWS` | `100000` | Ceiling on what a client may request. |
| `LOCAL_AUTH` | `true` | Email + password accounts. `false` for OIDC only. |
| `OIDC_ISSUER` | empty | Issuer URL. All four OIDC values empty disables SSO. |
| `OIDC_CLIENT_ID` | empty | Client id. |
| `OIDC_CLIENT_SECRET` | empty | Client secret. |
| `OIDC_REDIRECT_URI` | `http://localhost:5274/api/auth/oidc/callback` | Must match the provider's registration exactly. |
| `OIDC_LABEL` | empty | Text on the SSO button. |
| `COOKIE_SECURE` | `false` | `true` behind HTTPS; breaks login on plain `http://localhost`. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*`. Only behind a proxy you control. |
| `WEB_DIST` | empty | Directory of built web assets to serve. Empty in dev (Vite serves them). |

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl` + `Enter` | Run the statement under the cursor, or the selection if there is one. The statement it would run is outlined in the editor. |
| `Ctrl` + `Shift` + `Enter`, `F5` | Run the whole script in the active tab |
| `Esc` | Cancel the running statement (`pg_cancel_backend` on the session's pid). Only while a query is running, and only if no editor widget wants Escape first. |
| `Ctrl` + `Space` | Completions (schemas, tables, columns for the tab's connection) |
| `Ctrl` + `/` | Toggle comment |
| `Ctrl` + `S` | Save the current query |
| `Ctrl` + `P` | Search tables, connections and commands in one field; `>` restricts it to commands |
| `Ctrl` + `T` | New query tab |
| `Ctrl` + `W` | Close tab, which closes its session and releases the backend |
| `Ctrl` + `B` | Show/hide the sidebar |
| `Ctrl` + `1`…`9` | Switch to tab N |
| `Ctrl` + `C` (grid) | Copy the selected cells as TSV |
| `Ctrl` + `A` (grid) | Select every loaded row |
| Arrows / `Home` / `End` / `PageUp` / `PageDown` (grid) | Move the selection; hold `Shift` to extend it |
| `Enter` (grid) | Open the full value of the selected cell |

More rows load automatically from the open cursor as you scroll near the bottom; there is
no key for it.

Monaco's own default bindings still apply inside the editor.

## Limitations

Deliberate omissions, not bugs. Each one is a real ceiling.

- **No server-side session store.** Auth is a stateless signed cookie, so there is no
  instant revocation: deleting or disabling a user takes effect when their cookie expires,
  or immediately only if you rotate `APP_SECRET` (which logs out everyone).
- **Single process assumed.** Rate limiting and WebSocket fanout are per-process, and a
  query session lives in the memory of the process that created it. More than one replica
  needs sticky sessions or a shared bus; without that, a client can hit a process that has
  never heard of its session id.
- **Export runs on its own connection.** `COPY ... TO STDOUT` streams from a fresh client,
  which keeps a multi-gigabyte export from blocking the pinned one, but it means session
  state is not exportable: a `CREATE TEMP TABLE` result, or anything visible only inside
  your open transaction, cannot be exported. Materialise it to a real table first.
- **No plan visualiser.** `EXPLAIN (ANALYZE, FORMAT JSON)` output is shown as a collapsible
  JSON tree with timings, not as a flame graph or node diagram.
- **Schema editing is deliberately two-speed.** `CREATE TABLE` and the whole `ALTER` family
  (columns, types, `NOT NULL`, defaults, rename, constraints, indexes) are built in dialogs that
  generate the statement into a query tab, so you read it and your own pinned session runs it.
  Only `TRUNCATE` and `DROP TABLE` execute directly, behind a confirmation. Nothing rewrites your
  schema without showing you the SQL first.
- **One password per stored connection.** No IAM tokens, no client-certificate auth, no
  SSH tunnelling. `sslMode` up to `verify-full` is supported; everything beyond that is on
  the network you run this on.

## Development

```bash
npm ci
npm run typecheck     # tsc across server and web
npm test              # 78 unit tests, no database needed
npm run build         # server tsc + web Vite build
npm run dev           # both workspaces; web on 5273, server on 5274
```

`npm run dev` needs a `.env`. Copy `.env.example` and set `APP_DATABASE_URL` and `APP_SECRET`.
See [Quick start](#quick-start-windows--wsl) for the database itself. `.env` is gitignored and must
stay that way: `APP_SECRET` signs session cookies and encrypts stored connection passwords.

`scripts/smoke/api.mjs` and `scripts/smoke/ui.mjs` exercise a running instance end to end. They
need a live server, a seeded database and credentials, so they are not part of `npm test` or CI.

## License

MIT. See [LICENSE](LICENSE).
