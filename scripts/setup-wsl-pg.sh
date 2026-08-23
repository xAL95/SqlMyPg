#!/bin/sh
# SqlMyPg - make the WSL PostgreSQL cluster reachable from a Windows-hosted dev
# server, then create the app's metadata role and database.
#
#   sudo sh scripts/setup-wsl-pg.sh [--dry-run]
#
# Ubuntu ships PostgreSQL listening on the UNIX socket only, so nothing on the
# Windows side can connect. This script fixes that. It is idempotent: it prints
# every change it makes, backs up pg_hba.conf before touching it, and never
# rewrites postgresql.conf in place.
set -eu

ROLE=sqlmypg
DB=sqlmypg
PORT=5432
DRY=0

case "${1:-}" in
  '') ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: sudo sh $0 [--dry-run]" >&2; exit 2 ;;
esac

[ "$(id -u)" = 0 ] || { echo "must run as root: sudo sh $0 ${1:-}" >&2; exit 1; }

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '\nFAILED: %s\n' "$1" >&2; printf 'Next step: %s\n' "$2" >&2; exit 1; }
# returns 0 when the change should be applied, 1 in --dry-run
change() {
  if [ "$DRY" = 1 ]; then say "  [dry-run] would $1"; return 1; fi
  say "  [change] $1"
  return 0
}

# ---------------------------------------------------------------- cluster ----
step "cluster"
VER=""
if command -v pg_lsclusters >/dev/null 2>&1; then
  VER=$(pg_lsclusters --no-header 2>/dev/null | awk '$2 == "main" { print $1; exit }')
fi
if [ -z "$VER" ]; then
  VER=$(ls -d /etc/postgresql/*/main 2>/dev/null | awk -F/ '{ print $4 }' | sort -V | tail -1)
fi
[ -n "$VER" ] || die "no PostgreSQL cluster found under /etc/postgresql" \
  "sudo apt install postgresql, then re-run this script"

CONF="/etc/postgresql/$VER/main"
HBA="$CONF/pg_hba.conf"
DROPIN="$CONF/conf.d/10-sqlmypg.conf"
[ -d "$CONF" ] || die "$CONF does not exist" "run pg_lsclusters and check the cluster name"
say "  version $VER, config $CONF"

# ------------------------------------------------------------- listen_addr ---
step "TCP listener ($DROPIN)"
# WSL2 forwards Windows' localhost into the distro, so listening on localhost is
# enough for a dev server running on Windows - no 0.0.0.0 exposure needed.
WANT="# Written by scripts/setup-wsl-pg.sh - delete this file to undo.
# WSL2 forwards Windows localhost into this distro, so localhost is enough.
listen_addresses = 'localhost'
port = $PORT
password_encryption = 'scram-sha-256'"

NEED_RESTART=0
if [ -f "$DROPIN" ] && [ "$(cat "$DROPIN")" = "$WANT" ]; then
  say "  already correct"
else
  if change "write $DROPIN (listen_addresses = localhost, port $PORT)"; then
    mkdir -p "$CONF/conf.d"
    printf '%s\n' "$WANT" > "$DROPIN"
  fi
  NEED_RESTART=1
fi

# Debian packaging enables conf.d, but verify - a drop-in nobody includes is the
# most confusing possible failure.
if grep -Eq "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'conf\.d'" "$CONF/postgresql.conf"; then
  say "  conf.d is included by postgresql.conf"
elif change "append include_dir = conf.d to $CONF/postgresql.conf (backup first)"; then
  cp -a "$CONF/postgresql.conf" "$CONF/postgresql.conf.$(date +%Y%m%d-%H%M%S).bak"
  printf "\n# added by scripts/setup-wsl-pg.sh\ninclude_dir = 'conf.d'\n" >> "$CONF/postgresql.conf"
  NEED_RESTART=1
fi

# ----------------------------------------------------------------- pg_hba ----
step "host auth ($HBA)"
# true when an active host line already names this address
hba_covers() {
  awk -v addr="$1" '
    /^[[:space:]]*#/ { next }
    $1 == "host" || $1 == "hostssl" || $1 == "hostnossl" {
      split(addr, a, "/")
      for (i = 4; i <= NF; i++) if ($i == addr || $i == a[1]) found = 1
    }
    END { exit found ? 0 : 1 }
  ' "$2"
}

NEED_RELOAD=0
ADD=""
for addr in 127.0.0.1/32 ::1/128; do
  if hba_covers "$addr" "$HBA"; then
    say "  $addr already has a host line - left alone"
  else
    ADD="$ADD$addr "
  fi
done

if [ -n "$ADD" ]; then
  if change "add scram-sha-256 host lines for $ADD to $HBA (backup first)"; then
    cp -a "$HBA" "$HBA.$(date +%Y%m%d-%H%M%S).bak"
    printf '\n# added by scripts/setup-wsl-pg.sh: SqlMyPg dev server on Windows\n' >> "$HBA"
    for addr in $ADD; do
      printf 'host    all             all             %-23s scram-sha-256\n' "$addr" >> "$HBA"
    done
  fi
  NEED_RELOAD=1
fi

if [ "$DRY" = 1 ]; then
  step "dry run - stopping here"
  say "  would then: restart or reload cluster $VER,"
  say "              create role $ROLE and database $DB (owner $ROLE),"
  say "              verify with pg_isready -h 127.0.0.1 -p $PORT and a psql login,"
  say "              print the APP_DATABASE_URL line for .env"
  exit 0
fi

# --------------------------------------------------------------- restart -----
step "cluster restart/reload"
if [ "$NEED_RESTART" = 1 ]; then
  say "  restarting (listen_addresses needs a restart)"
  pg_ctlcluster "$VER" main restart || service postgresql restart
elif [ "$NEED_RELOAD" = 1 ]; then
  say "  reloading (pg_hba.conf only)"
  pg_ctlcluster "$VER" main reload || service postgresql reload
else
  say "  nothing to apply"
fi

psqlp() { sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 "$@"; }

ACTIVE=$(psqlp -tAc 'SHOW listen_addresses' 2>/dev/null || true)
[ -n "$ACTIVE" ] || die "cannot reach the cluster on its unix socket" \
  "sudo pg_ctlcluster $VER main start ; sudo tail -n 40 /var/log/postgresql/postgresql-$VER-main.log"
say "  listen_addresses is now: $ACTIVE"
case "$ACTIVE" in
  *localhost* | *127.0.0.1* | \*) ;;
  *) die "the drop-in did not take effect (listen_addresses = $ACTIVE)" \
       "make sure $CONF/postgresql.conf has no listen_addresses line after its include_dir line" ;;
esac

# ------------------------------------------------------------- role + db -----
step "role $ROLE and database $DB"
PASSWORD="${SQLMYPG_PASSWORD:-}"
PASSWORD_KNOWN=1
if [ -z "$PASSWORD" ]; then
  if command -v openssl >/dev/null 2>&1; then
    PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')
  else
    PASSWORD=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)
  fi
  say "  generated a password (printed once, at the end)"
fi
ESC=$(printf '%s' "$PASSWORD" | sed "s/'/''/g")

if [ "$(psqlp -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE'")" = 1 ]; then
  if [ -n "${SQLMYPG_PASSWORD:-}" ]; then
    say "  [change] role $ROLE exists - setting its password from \$SQLMYPG_PASSWORD"
    psqlp -c "ALTER ROLE \"$ROLE\" WITH LOGIN PASSWORD '$ESC'"
  else
    say "  role $ROLE exists - password left untouched"
    PASSWORD_KNOWN=0
  fi
else
  say "  [change] CREATE ROLE $ROLE LOGIN"
  psqlp -c "CREATE ROLE \"$ROLE\" WITH LOGIN PASSWORD '$ESC'"
fi

if [ "$(psqlp -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'")" = 1 ]; then
  say "  database $DB exists"
else
  say "  [change] CREATE DATABASE $DB OWNER $ROLE"
  psqlp -c "CREATE DATABASE \"$DB\" OWNER \"$ROLE\""
fi

# ---------------------------------------------------------------- verify -----
step "verify"
pg_isready -h 127.0.0.1 -p "$PORT" -q || die "pg_isready cannot reach 127.0.0.1:$PORT" \
  "sudo pg_ctlcluster $VER main restart ; sudo tail -n 40 /var/log/postgresql/postgresql-$VER-main.log"
say "  pg_isready: 127.0.0.1:$PORT is accepting connections"

if [ "$PASSWORD_KNOWN" = 1 ]; then
  PGPASSWORD="$PASSWORD" psql -X -q -tAc 'SELECT current_user, current_database()' \
    -h 127.0.0.1 -p "$PORT" -U "$ROLE" -d "$DB" \
    || die "TCP login as $ROLE failed" \
       "check the last lines of $HBA (scram-sha-256 for 127.0.0.1/32), then: sudo sh $0"
  say "  psql login as $ROLE over TCP: ok"
else
  say "  login test skipped - the password is unknown to this run."
  say "  Re-run with one you choose:  sudo SQLMYPG_PASSWORD=yourpassword sh $0"
fi

step "done - paste this into d:/Projects/SqlMyPg/.env"
if [ "$PASSWORD_KNOWN" = 1 ]; then
  say "APP_DATABASE_URL=postgres://$ROLE:$PASSWORD@127.0.0.1:$PORT/$DB"
  say ""
  say "This password is not stored anywhere else - copy it now."
else
  say "APP_DATABASE_URL=postgres://$ROLE:<existing password>@127.0.0.1:$PORT/$DB"
fi
say ""
say "Check the port from Windows PowerShell with:"
say "  Test-NetConnection 127.0.0.1 -Port $PORT"
