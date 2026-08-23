/**
 * The two DDL statements the schema tree runs on its own. Everything else it can do - CREATE
 * TABLE, every flavour of ALTER - is generated client-side into a query tab instead, so the user
 * reads it before it runs. These two are here because a confirm dialog is the better gesture for
 * them and there is nothing to compose: each is one statement with no user-supplied SQL in it.
 *
 * The identifiers come from the catalog via resolveRelation, never from the request, so the
 * statement text cannot be influenced by what was posted. There is nothing to parameterise -
 * TRUNCATE and DROP take no values.
 */
import { resolveRelation } from './browse.js';
import { quoteQualified } from './introspect.js';
import { withPooled, type TargetConfig } from './pool.js';

const httpError = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode });

export type DdlResult = { rowCount: number; sql: string; params: (string | null)[] };

/** Relation kinds TRUNCATE and DROP TABLE apply to: ordinary and partitioned tables. */
const TABLE_KINDS = new Set(['r', 'p']);

const KIND_NAME: Record<string, string> = {
  v: 'a view',
  m: 'a materialized view',
  f: 'a foreign table',
  i: 'an index',
  S: 'a sequence',
};

function mustBeTable(kind: string, qualifiedName: string, verb: string): void {
  if (TABLE_KINDS.has(kind)) return;
  const what = KIND_NAME[kind] ?? `relkind ${kind}`;
  throw httpError(400, `${qualifiedName} is ${what}, not a table, so it cannot be ${verb} here`);
}

/**
 * Empty a table. RESTART IDENTITY resets its identity/serial sequences, which is almost always
 * what "clear this table" is meant to do; CASCADE also truncates whatever references it, and is
 * required by Postgres if anything does - without it the statement fails rather than half-runs.
 */
export async function truncateTable(
  cfg: TargetConfig,
  req: { schema: string; name: string; restartIdentity?: boolean; cascade?: boolean },
): Promise<DdlResult> {
  const rel = await resolveRelation(cfg, req.schema, req.name);
  const name = quoteQualified(rel.schema, rel.name);
  mustBeTable(rel.relkind, name, 'cleared');

  const sql =
    `TRUNCATE TABLE ${name}` +
    (req.restartIdentity ? ' RESTART IDENTITY' : '') +
    (req.cascade ? ' CASCADE' : '');

  return withPooled(cfg, async (c) => {
    await c.query(sql);
    return { rowCount: 0, sql, params: [] };
  });
}

/** Drop a table. CASCADE also drops the views, foreign keys and anything else depending on it. */
export async function dropTable(
  cfg: TargetConfig,
  req: { schema: string; name: string; cascade?: boolean },
): Promise<DdlResult> {
  const rel = await resolveRelation(cfg, req.schema, req.name);
  const name = quoteQualified(rel.schema, rel.name);
  mustBeTable(rel.relkind, name, 'dropped');

  const sql = `DROP TABLE ${name}${req.cascade ? ' CASCADE' : ''}`;
  return withPooled(cfg, async (c) => {
    await c.query(sql);
    return { rowCount: 0, sql, params: [] };
  });
}

