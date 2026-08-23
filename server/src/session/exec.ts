import Cursor from 'pg-cursor';
import type { FieldDef, QueryResult } from 'pg';
import type {
  ExecRequest,
  ExecResponse,
  FetchResponse,
  FieldMeta,
  QueryError,
  Row,
  StatementResult,
} from '@shared/protocol.js';
import { recordQuery } from '../queryHistory.js';
import { env } from '../env.js';
import { newId } from '../crypto.js';
import { rawTypeParsers, withPooled } from '../pg/pool.js';
import { splitStatements } from '../pg/sqlSplit.js';
import type { SqlStatement } from '../pg/sqlSplit.js';
import { emitTo, runExclusive, type QuerySession } from './manager.js';

/** oid -> typname, per session: the catalog is per database and enums/domains are user defined */
const typeNames = new WeakMap<QuerySession, Map<number, string>>();

export async function execScript(s: QuerySession, req: ExecRequest): Promise<ExecResponse> {
  return runExclusive(s, async () => {
    const executionId = newId();
    // a new execution invalidates the previous result set, and its suspended portal would
    // otherwise block every statement below from being dispatched
    await dropCursor(s);

    const stmts = splitStatements(req.sql);
    const maxRows = clamp(req.maxRows ?? env.DEFAULT_MAX_ROWS, 1, env.MAX_MAX_ROWS);
    // only the last row-returning statement may keep its cursor: pg-cursor leaves the portal
    // suspended without a Sync, so an open cursor stalls anything else on this client
    const keepIdx = stmts.reduce((acc, st, i) => (usesCursor(st) ? i : acc), -1);

    emitTo(s.userId, { type: 'exec-start', sessionId: s.id, executionId, statementCount: stmts.length });

    const statements: StatementResult[] = [];
    let aborted = false;
    const scriptStart = performance.now();

    for (let i = 0; i < stmts.length; i++) {
      const st = stmts[i];
      if (!st) continue;
      emitTo(s.userId, { type: 'stmt-start', sessionId: s.id, executionId, index: i, sql: st.sql });

      const r: StatementResult = {
        index: i,
        sql: st.sql,
        offset: st.offset,
        kind: st.returnsRows ? 'rows' : 'command',
        command: null,
        fields: [],
        rows: [],
        rowCount: null,
        truncated: false,
        durationMs: 0,
        notices: [],
      };
      const t0 = performance.now();
      try {
        if (usesCursor(st)) await runCursor(s, st, maxRows, i === keepIdx, r);
        else await runDirect(s, st, maxRows, r);
      } catch (e) {
        r.error = toQueryError(e, st.offset);
        // postgres has aborted the transaction already; the rest of the script would only
        // replay the same failure, so stop and let the user decide
        aborted = true;
      }
      r.durationMs = round1(performance.now() - t0);
      r.notices = s.notices.splice(0);
      statements.push(r);
      emitTo(s.userId, {
        type: 'stmt-end',
        sessionId: s.id,
        executionId,
        index: i,
        durationMs: r.durationMs,
        rowCount: r.rowCount,
        command: r.command,
        error: r.error,
      });
      if (aborted) break;
    }

    // pg-cursor reports its error before it syncs, so the ReadyForQuery that carries the real
    // transaction status has not been read yet and s.txStatus is one statement stale. One
    // throwaway round trip forces it. Inside an aborted transaction this fails with 25P02,
    // which is exactly the case we need the status byte for, hence the swallowed error.
    if (aborted) {
      await s.client.query('SELECT 1').catch(() => undefined);
    }

    const totalDurationMs = round1(performance.now() - scriptStart);
    s.lastUsedAt = new Date();
    emitTo(s.userId, { type: 'exec-end', sessionId: s.id, executionId, txStatus: s.txStatus, aborted });
    recordHistory(s, req.sql, totalDurationMs, statements);
    return { executionId, statements, txStatus: s.txStatus, totalDurationMs, aborted };
  });
}

export async function fetchCursor(s: QuerySession, cursorId: string, count: number): Promise<FetchResponse> {
  return runExclusive(s, async () => {
    const open = s.cursor;
    if (!open || open.id !== cursorId) throw Object.assign(new Error('cursor no longer open'), { statusCode: 409 });
    const want = clamp(count, 1, env.MAX_MAX_ROWS);
    const rows = await open.cursor.read(want);
    open.totalFetched += rows.length;
    const done = rows.length < want;
    if (done) {
      s.cursor = null;
      await open.cursor.close().catch(() => {});
    }
    return { rows, done, totalFetched: open.totalFetched };
  });
}

export async function closeCursor(s: QuerySession): Promise<void> {
  await runExclusive(s, () => dropCursor(s));
}

/** a cursor needs the extended protocol, so statements flagged simpleOnly can never use one */
function usesCursor(st: SqlStatement): boolean {
  return st.returnsRows && !st.simpleOnly;
}

async function runDirect(s: QuerySession, st: SqlStatement, maxRows: number, r: StatementResult): Promise<void> {
  // no values array, so pg sends this over the simple query protocol - which is exactly what
  // simpleOnly statements (VACUUM, CREATE INDEX CONCURRENTLY, ...) require
  const res = await s.client.query({ text: st.sql, rowMode: 'array' });
  r.command = res.command ?? null;
  r.rowCount = res.rowCount;
  r.fields = await fieldMeta(s, res.fields ?? []);
  const rows = (res.rows ?? []) as Row[];
  // ponytail: a row-returning simpleOnly statement is materialised whole before we trim it,
  // upgrade path is a DECLARE CURSOR inside an explicit transaction if that ever hurts
  r.truncated = rows.length > maxRows;
  r.rows = r.truncated ? rows.slice(0, maxRows) : rows;
}

async function runCursor(
  s: QuerySession,
  st: SqlStatement,
  maxRows: number,
  keepOpen: boolean,
  r: StatementResult,
): Promise<void> {
  // pg-cursor's own types config is the only one it honours; without it the client-level raw
  // parsers are bypassed and rows come back as Date/number instead of strings
  const cursor = s.client.query(new Cursor<Row>(st.sql, undefined, { rowMode: 'array', types: rawTypeParsers }));
  const { rows, result } = await readCursor(cursor, maxRows);
  r.rows = rows;
  r.rowCount = rows.length;
  // the command tag only arrives once the cursor is exhausted, so fall back to the first word
  r.command = result.command || st.firstWord.toUpperCase() || null;
  r.fields = await fieldMeta(s, result.fields ?? []);

  if (keepOpen && rows.length === maxRows) {
    const id = newId();
    s.cursor = { id, cursor, fields: r.fields, totalFetched: rows.length, sql: st.sql };
    r.truncated = true;
    r.cursorId = id;
    return;
  }
  await cursor.close().catch(() => {});
}

/** the callback form is the only one that hands back the result, and we need its field list */
function readCursor(cursor: Cursor<Row>, count: number): Promise<{ rows: Row[]; result: QueryResult }> {
  return new Promise((resolve, reject) => {
    cursor.read(count, (err, rows, result) => {
      if (err) reject(err);
      else resolve({ rows, result });
    });
  });
}

async function dropCursor(s: QuerySession): Promise<void> {
  const open = s.cursor;
  if (!open) return;
  s.cursor = null;
  await open.cursor.close().catch(() => {});
}

async function fieldMeta(s: QuerySession, fields: FieldDef[]): Promise<FieldMeta[]> {
  const cache = typeNames.get(s) ?? new Map<number, string>();
  typeNames.set(s, cache);
  const missing = [...new Set(fields.map((f) => f.dataTypeID))].filter((oid) => !cache.has(oid));
  if (missing.length) {
    try {
      // deliberately a second connection: the pinned one may have a suspended cursor (nothing
      // can be dispatched on it) or a failed transaction (every query would error)
      const res = await withPooled(s.config, (c) =>
        c.query<{ oid: string; typname: string }>(
          'SELECT oid::text AS oid, typname FROM pg_type WHERE oid = ANY($1::oid[])',
          [missing],
        ),
      );
      for (const row of res.rows) cache.set(Number(row.oid), row.typname);
    } catch {
      // type names are cosmetic; the oid below is a usable fallback
    }
  }
  return fields.map((f) => ({
    name: f.name,
    dataTypeId: f.dataTypeID,
    typeName: cache.get(f.dataTypeID) ?? `oid:${f.dataTypeID}`,
    tableOid: f.tableID,
    columnId: f.columnID,
  }));
}

type PgErrorish = {
  message?: string;
  code?: string;
  position?: string;
  detail?: string;
  hint?: string;
  where?: string;
};

function toQueryError(e: unknown, scriptOffset: number): QueryError {
  const d = (typeof e === 'object' && e !== null ? e : {}) as PgErrorish;
  const position = Number(d.position);
  return {
    message: d.message ?? String(e),
    code: d.code,
    position: Number.isInteger(position) && position > 0 ? position : undefined,
    detail: d.detail,
    hint: d.hint,
    where: d.where,
    scriptOffset,
  };
}

function recordHistory(s: QuerySession, sql: string, durationMs: number, statements: StatementResult[]): void {
  const last = statements[statements.length - 1];
  recordQuery({
    userId: s.userId,
    connectionId: s.connectionId,
    connectionName: s.connectionName,
    sql,
    durationMs,
    rowCount: last?.rowCount ?? null,
    error: last?.error?.message ?? null,
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : lo;
}

function round1(ms: number): number {
  return Math.round(ms * 10) / 10;
}
