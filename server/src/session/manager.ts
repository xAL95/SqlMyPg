import { EventEmitter } from 'node:events';
import { Client } from 'pg';
import type Cursor from 'pg-cursor';
import type {
  CreateSessionRequest,
  FieldMeta,
  Notice,
  Row,
  ServerMessage,
  SessionState,
  TxStatus,
} from '@shared/protocol.js';
import { env } from '../env.js';
import { newId } from '../crypto.js';
import { cancelBackend, loadConnection, rawTypeParsers, targetConfig, withPooled } from '../pg/pool.js';
import type { TargetConfig } from '../pg/pool.js';

export type OpenCursor = {
  id: string;
  cursor: Cursor<Row>;
  fields: FieldMeta[];
  totalFetched: number;
  sql: string;
};

export type QuerySession = {
  id: string;
  userId: string;
  connectionId: string;
  connectionName: string;
  database: string;
  readOnly: boolean;
  /** a pinned pg.Client, never a pool client: temp tables and open transactions must survive between requests */
  client: Client;
  config: TargetConfig;
  backendPid: number;
  serverVersion: string;
  busy: boolean;
  txStatus: TxStatus;
  createdAt: Date;
  lastUsedAt: Date;
  notices: Notice[];
  cursor: OpenCursor | null;
  statementTimeoutMs: number;
  closing: boolean;
};

/** one channel for every session event; the websocket layer filters by userId */
export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(0);

export function emitTo(userId: string, message: ServerMessage): void {
  sessionEvents.emit('event', { userId, message });
}

const sessions = new Map<string, QuerySession>();
/** sessions whose pg build did not expose the readyForQuery hook; see the ponytail note in createSession */
const txPolled = new WeakSet<QuerySession>();
const chains = new WeakMap<QuerySession, Promise<unknown>>();

const LOCK_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_NOTICES = 1000;

function fail(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** SET forbids bind parameters, so anything that could reach a GUC textually is coerced to an integer first */
function coerceMs(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 86_400_000 ? Math.trunc(v) : dflt;
}

export async function createSession(userId: string, req: CreateSessionRequest): Promise<QuerySession> {
  if (listSessions(userId).length >= env.SESSION_MAX_PER_USER) {
    throw fail(429, `session limit reached (${env.SESSION_MAX_PER_USER}); close another query tab first`);
  }

  const row = await loadConnection(req.connectionId, userId);
  const config = targetConfig(row);
  const readOnly = row.readOnly === true;
  const statementTimeoutMs = coerceMs(req.statementTimeoutMs, env.DEFAULT_STATEMENT_TIMEOUT_MS);
  const client = new Client({ ...config, types: rawTypeParsers });

  await client.connect();
  const info = await probeAndConfigure(client, statementTimeoutMs, readOnly);

  const s: QuerySession = {
    id: newId(),
    userId,
    connectionId: row.id,
    connectionName: row.name,
    database: info.db,
    readOnly,
    client,
    config,
    backendPid: Number(info.pid),
    serverVersion: info.version,
    busy: false,
    txStatus: 'idle',
    createdAt: new Date(),
    lastUsedAt: new Date(),
    notices: [],
    cursor: null,
    statementTimeoutMs,
    closing: false,
  };

  // RAISE NOTICE from a long-running function has to reach the tab while the call is still
  // running, so notices are both buffered for the HTTP response and pushed over the socket now.
  client.on('notice', (n) => {
    const notice: Notice = {
      severity: n.severity ?? 'NOTICE',
      code: n.code,
      message: n.message ?? '',
      detail: n.detail,
      hint: n.hint,
    };
    // a chatty loop can raise millions of notices; the socket still gets all of them, only the
    // buffer that rides along with the HTTP response is capped
    if (s.notices.length < MAX_BUFFERED_NOTICES) s.notices.push(notice);
    emitTo(s.userId, { type: 'notice', sessionId: s.id, notice });
  });

  client.on('error', (e) => {
    // the backend died under us: drop the session instead of leaving a zombie holding a socket
    s.closing = true;
    sessions.delete(s.id);
    emitTo(s.userId, { type: 'session-closed', sessionId: s.id, reason: e.message });
  });

  // ponytail: transaction status is read from client.connection, a pg private API, because the
  // ReadyForQuery status byte is the only exact source (inferring it from the SQL is a guess).
  // If a pg upgrade removes the hook, pollTxStatus polls pg_stat_activity from a second
  // connection after every execution instead.
  const con = (client as unknown as {
    connection?: { on(e: string, cb: (m: { status?: string }) => void): void };
  }).connection;
  if (con?.on) {
    con.on('readyForQuery', (m) => {
      s.txStatus = m.status === 'T' ? 'in_transaction' : m.status === 'E' ? 'failed' : 'idle';
    });
  } else {
    txPolled.add(s);
  }

  sessions.set(s.id, s);
  emitTo(userId, { type: 'session-state', session: toState(s) });
  return s;
}

/** one round trip for the identity of the backend, then one for its GUCs; never leaks the socket */
async function probeAndConfigure(
  client: Client,
  statementTimeoutMs: number,
  readOnly: boolean,
): Promise<{ pid: string; version: string; db: string; usr: string }> {
  try {
    const probe = await client.query<{ pid: string; version: string; db: string; usr: string }>(
      'SELECT pg_backend_pid()::text AS pid, version() AS version, current_database() AS db, current_user AS usr',
    );
    const info = probe.rows[0];
    if (!info) throw new Error('session probe returned no row');

    // set_config takes bind parameters where SET does not, so no value is concatenated into SQL.
    // idle_in_transaction_session_timeout is the load-bearing one: an abandoned browser tab must
    // not hold locks forever even if the reaper never gets to it.
    await client.query(
      `SELECT set_config('statement_timeout', $1, false),
              set_config('idle_in_transaction_session_timeout', $2, false),
              set_config('lock_timeout', $3, false),
              set_config('default_transaction_read_only', $4, false)`,
      [
        String(statementTimeoutMs),
        String(coerceMs(env.SESSION_IDLE_TIMEOUT_MS, 1_800_000)),
        String(LOCK_TIMEOUT_MS),
        readOnly ? 'on' : 'off',
      ],
    );
    if (readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    return info;
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
}

export function getSession(id: string, userId: string): QuerySession {
  const s = sessions.get(id);
  if (!s) throw fail(404, 'session not found');
  if (s.userId !== userId) throw fail(403, 'not your session');
  return s;
}

export function listSessions(userId: string): QuerySession[] {
  return [...sessions.values()].filter((s) => s.userId === userId);
}

export async function closeSession(id: string, userId: string, reason = 'closed'): Promise<void> {
  const s = getSession(id, userId);
  s.closing = true;
  sessions.delete(id);
  await teardown(s);
  emitTo(userId, { type: 'session-closed', sessionId: id, reason });
}

export async function cancelSession(id: string, userId: string): Promise<boolean> {
  const s = getSession(id, userId);
  // must come from a second connection: the pinned one is blocked on the query being cancelled
  const ok: unknown = await cancelBackend(s.config, s.backendPid);
  return ok !== false;
}

export function toState(s: QuerySession): SessionState {
  return {
    id: s.id,
    connectionId: s.connectionId,
    connectionName: s.connectionName,
    database: s.database,
    busy: s.busy,
    txStatus: s.txStatus,
    backendPid: s.backendPid,
    createdAt: s.createdAt.toISOString(),
    lastUsedAt: s.lastUsedAt.toISOString(),
    hasOpenCursor: s.cursor !== null,
    serverVersion: s.serverVersion,
  };
}

/** per-session promise chain: a second exec queues instead of interleaving on the wire */
export function runExclusive<T>(s: QuerySession, fn: () => Promise<T>): Promise<T> {
  const mine = (chains.get(s) ?? Promise.resolve()).then(async () => {
    if (s.closing) throw fail(409, 'session is closing');
    s.busy = true;
    emitTo(s.userId, { type: 'session-state', session: toState(s) });
    try {
      return await fn();
    } finally {
      s.busy = false;
      s.lastUsedAt = new Date();
      await pollTxStatus(s);
      emitTo(s.userId, { type: 'session-state', session: toState(s) });
    }
  });
  chains.set(
    s,
    mine.then(
      () => undefined,
      () => undefined,
    ),
  );
  return mine;
}

async function pollTxStatus(s: QuerySession): Promise<void> {
  if (!txPolled.has(s)) return;
  try {
    const res = await withPooled(s.config, (c) =>
      c.query<{ state: string | null }>('SELECT state FROM pg_stat_activity WHERE pid = $1', [s.backendPid]),
    );
    const state = res.rows[0]?.state ?? null;
    s.txStatus =
      state === 'idle in transaction'
        ? 'in_transaction'
        : state === 'idle in transaction (aborted)'
          ? 'failed'
          : 'idle';
  } catch {
    // keep the last known status; a stale badge beats a failed request
  }
}

export function startReaper(): NodeJS.Timeout {
  const t = setInterval(() => {
    const cutoff = Date.now() - env.SESSION_IDLE_TIMEOUT_MS;
    for (const s of sessions.values()) {
      if (s.busy || s.closing || s.lastUsedAt.getTime() > cutoff) continue;
      void closeSession(s.id, s.userId, 'idle timeout').catch(() => {});
    }
  }, 30_000);
  t.unref();
  return t;
}

export async function closeAllSessions(reason: string): Promise<void> {
  await Promise.all(
    [...sessions.values()].map(async (s) => {
      s.closing = true;
      sessions.delete(s.id);
      await teardown(s);
      emitTo(s.userId, { type: 'session-closed', sessionId: s.id, reason });
    }),
  );
}

async function teardown(s: QuerySession): Promise<void> {
  const open = s.cursor;
  s.cursor = null;
  if (open) await open.cursor.close().catch(() => {});
  const bail = new Promise<void>((r) => {
    setTimeout(r, 3_000).unref();
  });
  await Promise.race([s.client.end().catch(() => {}), bail]);
  // end() can hang on a half-open socket and shutdown must not; destroying an already ended
  // client is a no-op, so this needs no branch
  (s.client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
}
