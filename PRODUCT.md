# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: a developer or operator who self-hosts SqlMyPg to work on their own PostgreSQL
servers.** The phpMyAdmin audience, for Postgres. Because it is distributed for anyone to
self-host, *the operator is usually not the author*. First run, defaults, and documentation
cannot assume any familiarity with the codebase.

Their situation: at a desktop, wide screen, real keyboard and mouse, a terminal and an editor
open beside the browser. One or more registered Postgres servers, some of which may be
production.

Their job: read a schema, page through table data, run SQL with real transaction semantics,
edit rows and schema, get results out.

Multi-user operation is a *capability* rather than a confirmed second audience: local password
auth, optional OIDC, an admin flag, per-user saved connections, and read-only connections all
exist, so a shared instance is supported without being the design centre.

## Product Purpose

A web UI for PostgreSQL in the phpMyAdmin class, self-hostable by anyone: browse schemas, run
SQL, page through tables, edit rows and schema, export results.

Success is that someone can point it at a Postgres server, including one with a billion-row
table, and do real work without the tool becoming either the bottleneck or the hazard.

## Positioning

**A query session is pinned to one Postgres backend for its whole life.** One editor tab owns
one `pg.Client`, never a pool checkout, and nothing else ever runs on that connection.

This is the claim a pooled competitor cannot truthfully copy. Temp tables, `SET LOCAL`,
advisory locks, cursors, `LISTEN`, prepared statements and `pg_temp` all behave exactly as they
do in `psql`; the tab's transaction status is the real backend's status; cancelling sends
`pg_cancel_backend` to the pid that session reported. On a pooled connection the second
statement of a `BEGIN; CREATE TEMP TABLE …` script lands on a different backend and fails.

The second, related claim: **nothing counts rows, offsets pages, or buffers a whole result
set.** Planner estimates instead of `COUNT(*)`, keyset seeks instead of `OFFSET`, server-side
cursors for the remainder, `COPY … TO STDOUT` streamed straight to the HTTP response.

## Operating Context

- **Desktop browser only.** A wide screen with a keyboard and mouse is a stated requirement,
  not a preference. Dense layouts, hover affordances, right-click menus, and modifier-key
  gestures are legitimate; no touch fallback is owed.
- **Two Postgres roles, kept strictly apart.** The *metadata database* is SqlMyPg's own storage
  (users, saved connections, history, saved queries), owned and migrated by the app. *Target
  databases* are the servers the user registered; against those the app only ever runs SQL the
  user asked for.
- **A connection is scoped to one database.** Reaching another database on the same cluster
  means another connection: Postgres cannot switch database on an open connection.
- **Self-hosted deployment:** a Docker image, or a Node process with `WEB_DIST` served by
  Fastify. Configuration is environment variables.
- **One browser tab = one session = one real backend.** Sessions per user are capped, because
  each one holds a live backend open until the tab closes or it idles out.
- Documented development path is Windows + WSL2 Ubuntu with PostgreSQL 18; the app itself is
  platform-neutral.

## Capabilities and Constraints

**Confirmed capabilities**

- Auth: local password (the first account created becomes admin) and optional OIDC; a stateless
  signed session cookie.
- Saved connections per user: encrypted stored password, `sslMode` up to `verify-full`, a
  read-only flag, and a colour tag.
- Query sessions on a pinned backend: live transaction status, notices, statement timeout,
  explicit cancel by backend pid, server-side cursors for truncated results.
- Monaco SQL editor with a Postgres language definition and completion from a catalog snapshot.
- Virtualised result grid: cell-rectangle and row selection (including Ctrl+click for
  non-contiguous rows), copy as TSV, CSV, or `INSERT` statements.
- Table browsing: keyset pagination, a `WHERE` filter, click-to-sort headers, planner row
  estimates shown as approximate.
- Row writes: insert, single-cell edit, and multi-row delete, each addressed by the relation's
  unique key.
- Editing a query result: a result column carries the oid of the table it came from, so a cell in
  any grid can be written back when it maps to a stored column of an ordinary table whose whole
  unique key is in the projection. Refused, with the reason on screen, when the value is computed,
  the relation is a view, the key is missing from the SELECT, or the tab has a transaction open.
  The last of those because a grid edit runs on a pooled connection and would block on that tab's
  own locks.
- Schema DDL: `CREATE TABLE` and the `ALTER` family (columns, types, `NOT NULL`, defaults,
  rename, constraints, indexes) generated into a query tab for review; `TRUNCATE` and
  `DROP TABLE` executed behind a confirmation.
- Export: `COPY … TO STDOUT` streamed to the response, on its own connection.
- Query history and saved queries; both typed statements and grid writes are recorded as
  re-runnable SQL.
- Introspection: schemas, relations, columns, indexes, constraints, routines, and `EXPLAIN`
  output as a collapsible JSON tree.

**Declared ceilings: deliberate omissions, not defects**

- No server-side session store, so no instant revocation: a deleted user's cookie works until
  it expires, or until `APP_SECRET` is rotated (which logs out everyone).
- Single process assumed. Rate limiting and WebSocket fanout are per-process, and a session
  lives in the memory of the process that created it; replicas need sticky sessions.
- Export runs on a fresh connection, so session state is not exportable. A temp table or
  anything visible only inside an open transaction must be materialised first.
- No plan visualiser. `EXPLAIN (ANALYZE, FORMAT JSON)` is a JSON tree with timings, not a flame
  graph.
- One password per stored connection: no IAM tokens, client certificates, or SSH tunnelling.
- A table with no primary key or unique index is read-only in the grid. Browsing falls back to
  `ctid`, and a `ctid` is not an identity: `VACUUM` or an `UPDATE` relocates a live row and a
  later `INSERT` can reuse the vacated one, so a captured `ctid` may address a different row by
  the time it is used. Editing those rows means writing the predicate yourself.
- Browsing and grid writes run on a *pooled* connection, which never receives the
  `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` that a pinned session gets, so the
  read-only flag is enforced per route, not by the connection itself.

**Terminology** (used consistently in code, UI, and docs)

- *metadata database* vs *target database*
- *session* (a pinned backend) vs *connection* (saved credentials for one database)
- *relation* for anything in `pg_class` the UI can list

**Explicitly undecided**

- No accessibility standard has been chosen (see below).
- Whether a shared/team instance becomes a first-class audience, or stays a supported
  capability.

## Brand Commitments

- **Name:** SqlMyPg. No logo, wordmark, or icon asset exists. The app draws its own mark: three
  ascending bars in a filled accent tile, beside the product name set in the UI face.
- **Visual convention is a standing commitment** *(stated by the operator, 2026-08-22)*: this
  product should look and behave like a modern desktop developer tool, alongside **TablePlus**,
  **DataGrip** and **Supabase Studio**. Their craft level is the bar. The convention is to be
  executed at full fidelity: rounded panels, soft tonal gradations, a clear accent colour,
  generous padding, and the system UI face for everything operable. Monospace is confined to SQL
  in the editor and values in the data grid.
  - This supersedes the earlier "must not look like a rounded-panel dark IDE" constraint and the
    "Dealing Desk" direction built on it, both of which the operator rejected by name.
  - Two specific complaints drove it and are part of the commitment: **the monospace interface was
    hard to read**, and **the UI was too small overall**. Do not reintroduce a monospace interface
    face, and do not drop the interface below a 14px base or controls below 32px.
  - The operator also asked for **newbie friendly**: no important action reachable only by
    right-click, every icon control labelled, and empty states that name the next step.
- **Voice** *(inferred from the author's own README and UI copy, not separately confirmed)*:
  direct and technical. It explains mechanism rather than benefit, states costs in the same
  breath as capabilities ("The cost is honest and stated in Limitations"), and calls deliberate
  omissions ceilings, not bugs. No marketing register, no superlatives.

## Evidence on Hand

- `README.md`, holding the mechanism explanation, the large-result handling table, the quick start, and
  an explicit Limitations section. Written by the author; real.
- `scripts/smoke/`, three genuine end-to-end scripts against a real PostgreSQL: `api.mjs`
  (sessions, temp tables, cursors, cancellation, keyset paging, `COPY` export, read-only
  sessions, WebSocket streaming), `ui.mjs` (Playwright, fails on any console error), and
  `seed.cjs` (fixtures).
- Test fixtures that make the scale claims demonstrable: a 5,000,000-row table, a composite-PK
  table, a table with no unique key, and a view.
- Unit tests for the pure logic behind destructive paths: DDL generation, row selection, CSV/SQL
  formatting, SQLSTATE classification, history parameter inlining.

**Absent, and future work must not fabricate any of it:** no users, testimonials, case studies,
customers, press, benchmarks, pricing, or licensing claims. No logo, screenshots, or marketing
imagery of any kind.

**Documentation drift:** resolved on 2026-08-23. `README.md`'s Limitations no longer claims there
is no DDL builder; it now describes the two-speed rule the build actually follows (dialogs generate
`CREATE TABLE` and `ALTER` into a query tab; only `TRUNCATE` and `DROP TABLE` execute directly).
The README also gained a "What it does" section, because it had been describing only browse, run
and export while the build had grown row writes, result editing, roles and privileges.

## Product Principles

1. **Behave like `psql`, not like a pooled web app.** If a statement would work in a `psql`
   session, it works here. The pinned backend exists for exactly this, and no feature may
   quietly break it.
2. **Never count, never offset, never buffer.** Scale is handled with planner estimates, keyset
   seeks, server-side cursors, and streaming. A feature that needs `COUNT(*)` or `OFFSET` is the
   wrong feature.
3. **State the ceiling, and refuse rather than guess.** Limits are written down as limits. Where
   the tool cannot act safely, such as a row with no unique key or a `DROP` with dependents, it
   refuses with the reason instead of half-applying something.
4. **Show the statement.** Every write is recorded as re-runnable SQL, and irreversible schema
   changes are read before they run. Values reach Postgres as bound parameters; the readable form
   is for the human, never for execution.
5. **The operator is not the author.** It is self-hosted by strangers, so defaults must be safe,
   first run must explain itself, and nothing may assume knowledge of the source.

## Accessibility & Inclusion

**Not established, and an open decision.** The result grid already carries `aria-sort`, button
roles, and full keyboard navigation, because a SQL tool is keyboard-driven by nature, but no
standard has been chosen and no audit has been run. Future work must not claim a compliance
level. Note that the desktop-only decision above is a deliberate scope choice, not an
accessibility position.
