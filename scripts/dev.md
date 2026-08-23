# dev cheat sheet

Run everything from the repo root in PowerShell unless noted.

Where a command has to reach into WSL, `$repo` is the checkout as WSL sees it. Set it once per
shell, from the repo root:

```powershell
$repo = wsl wslpath -a ((Get-Location).Path -replace '\\', '/')
```

| Task | Command |
| --- | --- |
| Typecheck both workspaces | `npm run typecheck` |
| Server tests | `npm test` |
| Both dev servers (:5274 + :5273) | `npm run dev` |
| Server only (tsx watch, :5274) | `npm run dev:server` |
| Web only (vite, :5273) | `npm run dev:web` |
| Push the schema to the metadata DB | `npm run db:push` |
| Generate a migration file | `cd server; npx drizzle-kit generate` |
| Build for production | `npm run build` then `npm start` |

`npm run dev` spawns both through `scripts/dev.mjs`, and Ctrl+C stops both. It used to
background the server with POSIX `&`; npm shells out to `cmd.exe` on Windows, where `&`
is sequential, so vite never started and :5273 refused connections.

`npm run db:push` and `drizzle-kit generate` both read `APP_DATABASE_URL` from `.env`.
`generate` writes SQL into `server/migrations/`; the server applies pending migrations
from that directory on boot, so `db:push` is only a shortcut while iterating on the schema.

## Reset the metadata database

Drops everything SqlMyPg stores about itself (users, saved connections, history) and
recreates it empty. It never touches the databases you browse.

```powershell
wsl -d Ubuntu-26.04 -- sudo -u postgres psql -c "DROP DATABASE IF EXISTS sqlmypg" -c "CREATE DATABASE sqlmypg OWNER sqlmypg"
npm run db:push
```

## psql inside WSL

```powershell
# as the app role, over TCP - same path the server uses
wsl -d Ubuntu-26.04 -- env PGPASSWORD=yourpassword psql -h 127.0.0.1 -U sqlmypg -d sqlmypg

# as superuser, over the unix socket - for GRANTs and role fixes
wsl -d Ubuntu-26.04 -- sudo -u postgres psql
```

## Smoke tests

Three scripts, no test framework. They need a running server, and the UI one also needs
`npm run dev:web` plus a saved connection named `demo (wsl)` pointing at the `demo` database.

```powershell
# 1. fixtures: a 5M-row table, a composite-PK table, a table with no unique key, a view
$env:SEED_URL="postgres://sqlmypg:yourpassword@127.0.0.1:5432/"; node scripts/smoke/seed.cjs

# 2. the API end to end: sessions, temp tables, cursors, cancellation, keyset paging, COPY export
$env:SMOKE_DB_PASSWORD="yourpassword"; node scripts/smoke/api.mjs

# 3. the browser: renders, signs in, runs SQL, fails on any console error
npx playwright install chromium   # once
$env:SMOKE_EMAIL="you@example.com"; $env:SMOKE_PASSWORD="yourpassword"; node scripts/smoke/ui.mjs
```

`api.mjs` creates its own admin account on first run (whatever `SMOKE_EMAIL`/`SMOKE_PASSWORD`
say) and leaves a `demo (wsl)` connection behind, which is what `ui.mjs` then drives.
`ui.mjs` writes `ui-*.png` screenshots into `SMOKE_SHOTS` (default: the current directory).

## The three errors you will actually hit

**1. `ECONNREFUSED 127.0.0.1:5432`** (or `could not connect to server: Connection refused`)

The WSL cluster is listening on the unix socket only, so Windows cannot reach it. Fix:

```powershell
wsl -d Ubuntu-26.04 -- sudo sh "$repo/scripts/setup-wsl-pg.sh"
```

**2. `FATAL: role "<your windows user>" does not exist`** (or `password authentication failed for user "sqlmypg"`)

There is no role named after your Windows user, and psql defaults to it. Either name the
role explicitly (`-U sqlmypg`, or the full `APP_DATABASE_URL`), or create/repair it:

```powershell
wsl -d Ubuntu-26.04 -- sudo SQLMYPG_PASSWORD=yourpassword sh "$repo/scripts/setup-wsl-pg.sh"
```

If the script itself dies with `$'\r': command not found`, it picked up CRLF line endings:
`wsl -d Ubuntu-26.04 -- sed -i 's/\r$//' "$repo/scripts/setup-wsl-pg.sh"`. `.gitattributes`
checks it out as LF, so this should only happen to a copy made outside git.

**3. Everything worked, then every request started 500ing with `ECONNREFUSED`**

WSL shut the distro down (it does that when idle) and took PostgreSQL with it. The server
logs `terminating connection due to administrator command` on its pooled connections first,
which is the tell. Any `wsl` command wakes the distro and systemd restarts the cluster:

```powershell
wsl -d Ubuntu-26.04 -- pg_isready -h 127.0.0.1 -p 5432
```

The server recovers on its own once the cluster is back, because `pg.Pool` reconnects on the
next query. But every **query session** open at that moment is gone, because a pinned backend
cannot survive its server restarting. Reload the browser tab to get a fresh session.
