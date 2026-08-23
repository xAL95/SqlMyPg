/**
 * SQLSTATE of a Postgres error, or undefined for anything else.
 *
 * `severity` is what separates a pg DatabaseError from a node syscall error: `EPIPE` is also
 * five uppercase characters, so `code` alone would misreport a dead socket as the user's SQL.
 * Class XX is Postgres reporting its own internal error, which stays a 500.
 */
export function pgSqlstate(err: unknown): string | undefined {
  const d = err as { code?: unknown; severity?: unknown } | null;
  if (!d || typeof d.severity !== 'string' || typeof d.code !== 'string') return undefined;
  return d.code.length === 5 && !d.code.startsWith('XX') ? d.code : undefined;
}

/** insufficient_privilege - the target role lacks a grant, which is a 403 and not a bad request. */
export const INSUFFICIENT_PRIVILEGE = '42501';
