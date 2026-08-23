import { db } from './db/index.js';
import { queryHistory } from './db/schema.js';
import { newId } from './crypto.js';
import { sessionEvents } from './session/manager.js';

export type HistoryEntryInput = {
  userId: string;
  connectionId: string;
  connectionName: string;
  sql: string;
  durationMs: number;
  rowCount: number | null;
  error: string | null;
};

/**
 * The one writer for query history, shared by the pinned-session exec path and the writes the
 * data grid makes on a pooled connection. Fire-and-forget on purpose: failing to log must never
 * fail the statement the user actually asked for.
 */
export function recordQuery(entry: HistoryEntryInput): void {
  db.insert(queryHistory)
    .values({
      id: newId(),
      userId: entry.userId,
      connectionId: entry.connectionId,
      connectionName: entry.connectionName,
      // every path into history goes through here, so redaction cannot be forgotten at a call site
      sql: redactSecrets(entry.sql).slice(0, 100_000),
      durationMs: Math.round(entry.durationMs),
      rowCount: entry.rowCount,
      error: entry.error,
    })
    // After the row lands, not before: telling the client to refetch first would race the
    // insert and show it the list it already had.
    .then(() =>
      sessionEvents.emit('event', {
        userId: entry.userId,
        message: { type: 'history', connectionId: entry.connectionId },
      }),
    )
    .catch((e: unknown) => console.error('query history insert failed', e));
}

/**
 * Substitute bound parameters into a statement so the history row is readable and re-runnable.
 *
 * Only for logging - the statement Postgres executes always keeps its placeholders, so this can
 * never turn a value into SQL. It assumes the text contains no string literals of its own, which
 * holds for the generated INSERT/UPDATE/DELETE the grid builds from catalog identifiers.
 */
export function inlineParams(sql: string, params: readonly (string | null)[]): string {
  return sql.replace(/\$(\d+)/g, (whole, digits: string) => {
    const v = params[Number(digits) - 1];
    if (v === undefined) return whole;
    return v === null ? 'NULL' : `'${v.replaceAll("'", "''")}'`;
  });
}

/**
 * Blank out role passwords before a statement is stored.
 *
 * History keeps SQL verbatim so an entry stays re-runnable, which is right for every statement
 * except the ones carrying a secret: `CREATE ROLE … PASSWORD 'x'` would otherwise sit in the
 * metadata database in plaintext, and in the History panel, forever. Postgres writes the secret
 * as a bare literal after the keyword, with no `=`, which is what separates it from a predicate
 * like `WHERE password = 'x'` over your own data - that stays, because redacting it would corrupt
 * legitimate history.
 *
 * ceiling: single-quoted literals only. A dollar-quoted `PASSWORD $$x$$` is legal and rare, and is
 * not matched here; the upgrade is to reuse the dollar-quote scanner from sqlSplit.
 */
export function redactSecrets(sql: string): string {
  // PASSWORD 'x', ENCRYPTED PASSWORD 'x', and the password option of a user mapping all take this
  // shape. \b keeps `password_encryption` out of it.
  return sql.replace(/\bpassword\s+('(?:[^']|'')*')/gi, (m) => m.replace(/'(?:[^']|'')*'/, "'<redacted>'"));
}
