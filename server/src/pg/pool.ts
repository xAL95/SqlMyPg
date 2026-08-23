/**
 * Connection pools for TARGET databases - the Postgres servers the user browses.
 * App metadata lives elsewhere (src/db); nothing here touches it except loadConnection.
 */
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { SslMode, TestConnectionResult } from '@shared/protocol.js';
import { db } from '../db/index.js';
import { connections, type ConnectionRow } from '../db/schema.js';
import { decryptSecret } from '../crypto.js';

export type TargetConfig = pg.ClientConfig & { host: string; port: number; database: string; user: string };

/**
 * ponytail: prefer and require encrypt the socket but do not verify the server chain, so they
 * stop a passive eavesdropper and not an active MITM; upgrade = a per-connection CA bundle
 * column passed as ssl.ca with rejectUnauthorized on, which also gives us verify-ca.
 */
export function sslFor(mode: SslMode): pg.ClientConfig['ssl'] {
  if (mode === 'disable') return false;
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

/**
 * Every column arrives as the exact text Postgres sent. Deliberate: int8 and numeric do not
 * survive a JS number, and timestamps do not survive a Date. A data browser shows values, it
 * does not reinterpret them.
 */
export const rawTypeParsers: pg.CustomTypesConfig = { getTypeParser: () => (v: string) => v };

export function targetConfig(row: ConnectionRow): TargetConfig {
  return {
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.dbUser,
    password: row.passwordEnc === null ? undefined : decryptSecret(row.passwordEnc),
    ssl: sslFor(row.sslMode as SslMode),
    application_name: 'sqlmypg',
  };
}

const pools = new Map<string, pg.Pool>();

/**
 * ponytail: the cache key leaves out the password, so editing a connection's password only
 * takes effect after closeAllPools(); upgrade = evict this entry from the connections
 * update route.
 */
export function poolFor(cfg: TargetConfig, opts?: { raw?: boolean }): pg.Pool {
  const raw = opts?.raw === true;
  const key = JSON.stringify([cfg.host, cfg.port, cfg.database, cfg.user, raw]);
  const existing = pools.get(key);
  if (existing) return existing;
  const pool = new pg.Pool({
    ...cfg,
    ...(raw ? { types: rawTypeParsers } : {}),
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client whose socket dies emits on the pool, and an unhandled 'error' event
  // takes the process down with it.
  pool.on('error', (err) => {
    console.error(`[pool] idle client error on ${cfg.host}:${cfg.port}/${cfg.database}: ${err.message}`);
  });
  pools.set(key, pool);
  return pool;
}

/** Codes that mean the socket is gone or out of sync: such a client must not go back in the pool. */
const BROKEN_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  '08000',
  '08003',
  '08006',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
]);

function looksBroken(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (!e) return false;
  if (typeof e.code === 'string' && BROKEN_CODES.has(e.code)) return true;
  return typeof e.message === 'string' && /connection terminated|socket hang up|connection error/i.test(e.message);
}

export async function withPooled<T>(
  cfg: TargetConfig,
  fn: (c: pg.PoolClient) => Promise<T>,
  opts?: { raw?: boolean },
): Promise<T> {
  const client = await poolFor(cfg, opts).connect();
  let destroy = false;
  try {
    return await fn(client);
  } catch (err) {
    destroy = looksBroken(err);
    throw err;
  } finally {
    client.release(destroy); // release(true) destroys instead of handing a dead client to the next caller
  }
}

export async function closeAllPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.allSettled(all.map((p) => p.end()));
}

export async function loadConnection(connectionId: string, userId: string): Promise<ConnectionRow> {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.ownerId, userId)))
    .limit(1);
  if (!row) throw Object.assign(new Error('Connection not found'), { statusCode: 404 });
  return row;
}

export async function cancelBackend(cfg: TargetConfig, pid: number): Promise<boolean> {
  return withPooled(cfg, async (client) => {
    const res = await client.query<{ cancelled: boolean }>('select pg_cancel_backend($1) as cancelled', [pid]);
    return res.rows[0]?.cancelled === true;
  });
}

/** Throwaway client on purpose: an unsaved or unreachable connection must not create a pool. */
export async function testConnection(cfg: TargetConfig): Promise<TestConnectionResult> {
  const client = new pg.Client({ ...cfg, connectionTimeoutMillis: 10_000 });
  const started = performance.now();
  try {
    await client.connect();
    const res = await client.query<{ full: string; short: string }>(
      "select version() as full, current_setting('server_version') as short",
    );
    return {
      ok: true,
      serverVersion: res.rows[0]?.short ?? res.rows[0]?.full ?? '',
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.end().catch(() => {});
  }
}
