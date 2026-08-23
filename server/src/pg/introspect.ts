import type {
  ColumnInfo,
  CompletionSnapshot,
  ConstraintInfo,
  IndexInfo,
  RelationDetail,
  RelationInfo,
  RoutineInfo,
  SchemaInfo,
} from '@shared/protocol.js';
import type { TargetConfig } from './pool.js';
import { withPooled } from './pool.js';

/**
 * Everything here reads pg_catalog directly and stays O(catalog), never O(rows):
 * information_schema is a stack of views that gets unusable on a big catalog, and
 * reltuples / pg_total_relation_size are planner and storage metadata, not table scans.
 */

const httpError = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode });

export function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** pg_temp_N / pg_toast_temp_N are per-backend, hence the LIKE rather than a fixed list. */
const IS_SYSTEM_SCHEMA = `(
    n.nspname IN ('pg_catalog', 'information_schema', 'pg_toast')
    OR n.nspname LIKE 'pg_temp%'
    OR n.nspname LIKE 'pg_toast_temp%'
  )`;

const BROWSABLE_RELKINDS = `('r', 'v', 'm', 'p', 'f')`;

export const REL_KIND = `CASE c.relkind
           WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview'
           WHEN 'p' THEN 'partitioned' ELSE 'foreign' END`;

const REL_SELECT = `SELECT c.oid AS oid,
         n.nspname AS schema,
         c.relname AS name,
         ${REL_KIND} AS kind,
         GREATEST(c.reltuples, 0)::float8 AS "estimatedRows",
         (CASE WHEN c.relkind IN ('r', 'm', 'p', 'f')
               THEN pg_catalog.pg_total_relation_size(c.oid) ELSE 0 END)::int8 AS "totalBytes",
         pg_catalog.obj_description(c.oid, 'pg_class') AS comment
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`;

/** int8 arrives as a string under the default parsers, and reltuples is a float estimate. */
type RawRelation = Omit<RelationInfo, 'oid' | 'totalBytes'> & {
  oid: string | number;
  totalBytes: string | number;
};

const toRelation = (r: RawRelation): RelationInfo => ({
  ...r,
  oid: Number(r.oid),
  estimatedRows: Math.round(r.estimatedRows),
  totalBytes: Number(r.totalBytes),
});

export async function listSchemas(cfg: TargetConfig): Promise<SchemaInfo[]> {
  return withPooled(cfg, async (c) => {
    const r = await c.query<SchemaInfo>(
      `SELECT n.nspname AS name,
              COALESCE(r.rolname::text, '') AS owner,
              ${IS_SYSTEM_SCHEMA} AS "isSystem"
         FROM pg_catalog.pg_namespace n
         LEFT JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
        ORDER BY "isSystem", name`,
    );
    return r.rows;
  });
}

export async function listRelations(cfg: TargetConfig, schema: string): Promise<RelationInfo[]> {
  return withPooled(cfg, async (c) => {
    const r = await c.query<RawRelation>(
      `${REL_SELECT}
        WHERE n.nspname = $1 AND c.relkind IN ${BROWSABLE_RELKINDS}
        ORDER BY c.relname`,
      [schema],
    );
    return r.rows.map(toRelation);
  });
}

export async function relationDetail(
  cfg: TargetConfig,
  schema: string,
  name: string,
): Promise<RelationDetail> {
  return withPooled(cfg, async (c) => {
    const rel = await c.query<RawRelation>(
      `${REL_SELECT}
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ${BROWSABLE_RELKINDS}`,
      [schema, name],
    );
    const row = rel.rows[0];
    if (!row) throw httpError(404, `relation ${quoteQualified(schema, name)} does not exist`);
    const oid = Number(row.oid);

    // pg queues queries per client, so these four pipeline on the one pooled connection.
    const [columns, indexes, constraints, referencedBy] = await Promise.all([
      c.query<ColumnInfo>(
        `SELECT a.attname AS name,
                a.attnum AS position,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS "typeName",
                a.attnotnull AS "notNull",
                pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "defaultExpr",
                COALESCE(a.attnum = ANY (pk.conkey), false) AS "isPrimaryKey",
                a.attidentity <> '' AS identity,
                a.attgenerated <> '' AS generated,
                pg_catalog.col_description(a.attrelid, a.attnum) AS comment
           FROM pg_catalog.pg_attribute a
           LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           LEFT JOIN pg_catalog.pg_constraint pk ON pk.conrelid = a.attrelid AND pk.contype = 'p'
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [oid],
      ),
      c.query<Omit<IndexInfo, 'totalBytes'> & { totalBytes: string }>(
        `SELECT ci.relname AS name,
                pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
                i.indisprimary AS "isPrimary",
                i.indisunique AS "isUnique",
                i.indisvalid AS "isValid",
                pg_catalog.pg_relation_size(i.indexrelid)::int8 AS "totalBytes"
           FROM pg_catalog.pg_index i
           JOIN pg_catalog.pg_class ci ON ci.oid = i.indexrelid
          WHERE i.indrelid = $1
          ORDER BY i.indisprimary DESC, ci.relname`,
        [oid],
      ),
      c.query<ConstraintInfo>(
        `SELECT con.conname AS name,
                con.contype::text AS kind,
                pg_catalog.pg_get_constraintdef(con.oid) AS definition
           FROM pg_catalog.pg_constraint con
          WHERE con.conrelid = $1 AND con.contype IN ('p', 'f', 'u', 'c', 'x', 't')
          ORDER BY con.contype, con.conname`,
        [oid],
      ),
      c.query<{ schema: string; name: string; constraint: string }>(
        `SELECT n.nspname AS schema, c2.relname AS name, con.conname AS constraint
           FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c2 ON c2.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c2.relnamespace
          WHERE con.contype = 'f' AND con.confrelid = $1
          ORDER BY n.nspname, c2.relname, con.conname`,
        [oid],
      ),
    ]);

    return {
      relation: toRelation(row),
      columns: columns.rows,
      indexes: indexes.rows.map((i) => ({ ...i, totalBytes: Number(i.totalBytes) })),
      constraints: constraints.rows,
      referencedBy: referencedBy.rows,
    };
  });
}

export async function listRoutines(cfg: TargetConfig, schema: string): Promise<RoutineInfo[]> {
  return withPooled(cfg, async (c) => {
    const r = await c.query<RoutineInfo>(
      `SELECT n.nspname AS schema,
              p.proname AS name,
              CASE p.prokind WHEN 'f' THEN 'function' ELSE 'procedure' END AS kind,
              pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
              COALESCE(pg_catalog.pg_get_function_result(p.oid), '') AS returns
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
        ORDER BY p.proname, args`,
      [schema],
    );
    return r.rows;
  });
}

export async function completionSnapshot(cfg: TargetConfig): Promise<CompletionSnapshot> {
  return withPooled(cfg, async (c) => {
    const r = await c.query<Omit<CompletionSnapshot, 'fetchedAt'>>(
      // ponytail: hard 20k relation cap on the autocomplete blob, upgrade path is
      // per-schema lazy loading in the editor if a catalog really is bigger than that.
      `WITH sch AS (
         SELECT n.oid, n.nspname
           FROM pg_catalog.pg_namespace n
          WHERE NOT ${IS_SYSTEM_SCHEMA}
       ), rel AS (
         SELECT s.nspname AS schema, c.relname AS name, ${REL_KIND} AS kind,
                (SELECT COALESCE(array_agg(a.attname::text ORDER BY a.attnum), '{}'::text[])
                   FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
           FROM pg_catalog.pg_class c
           JOIN sch s ON s.oid = c.relnamespace
          WHERE c.relkind IN ${BROWSABLE_RELKINDS}
          ORDER BY s.nspname, c.relname
          LIMIT 20000
       )
       SELECT (SELECT COALESCE(json_agg(s.nspname ORDER BY s.nspname), '[]'::json) FROM sch s)
                AS schemas,
              (SELECT COALESCE(json_agg(json_build_object(
                        'schema', r.schema, 'name', r.name,
                        'kind', r.kind, 'columns', r.columns)), '[]'::json)
                 FROM rel r) AS relations,
              (SELECT COALESCE(json_agg(DISTINCT p.proname::text), '[]'::json)
                 FROM pg_catalog.pg_proc p
                 JOIN sch s ON s.oid = p.pronamespace
                WHERE p.prokind IN ('f', 'p')) AS functions`,
    );
    const row = r.rows[0];
    return {
      schemas: row?.schemas ?? [],
      relations: row?.relations ?? [],
      functions: row?.functions ?? [],
      fetchedAt: new Date().toISOString(),
    };
  });
}

export async function serverInfo(
  cfg: TargetConfig,
): Promise<{ version: string; database: string; user: string }> {
  return withPooled(cfg, async (c) => {
    const r = await c.query<{ version: string; database: string; user: string }>(
      `SELECT version() AS version,
              current_database()::text AS database,
              current_user::text AS "user"`,
    );
    return r.rows[0] ?? { version: '', database: '', user: '' };
  });
}

export async function estimateRows(cfg: TargetConfig, schema: string, name: string): Promise<number> {
  return withPooled(cfg, async (c) => {
    const r = await c.query<{ estimate: number }>(
      `SELECT GREATEST(c.reltuples, 0)::float8 AS estimate
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ${BROWSABLE_RELKINDS}`,
      [schema, name],
    );
    const row = r.rows[0];
    if (!row) throw httpError(404, `relation ${quoteQualified(schema, name)} does not exist`);
    return Math.round(row.estimate);
  });
}

export async function explainPlan(
  cfg: TargetConfig,
  sql: string,
  opts: { analyze?: boolean; buffers?: boolean },
): Promise<unknown> {
  const body = sql.trim().replace(/;+\s*$/, '');
  if (!body) throw httpError(400, 'nothing to explain');
  if (opts.analyze) {
    // EXPLAIN ANALYZE really runs the statement, so the guard lives here, not in the caller.
    // ponytail: a WITH-prefixed SELECT is refused too, because `WITH x AS (...) INSERT` is
    // indistinguishable from a read by regex; upgrade path is a real statement classifier.
    const head = body.replace(/^(?:\s+|--[^\n]*|\/\*[\s\S]*?\*\/)+/, '');
    if (!/^select\b/i.test(head)) {
      throw httpError(400, 'EXPLAIN ANALYZE executes the statement; only a plain SELECT is allowed');
    }
  }
  const options = ['FORMAT JSON'];
  if (opts.analyze) options.push('ANALYZE');
  if (opts.buffers) options.push('BUFFERS');
  return withPooled(cfg, async (c) => {
    const r = await c.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (${options.join(', ')}) ${body}`,
    );
    return r.rows[0]?.['QUERY PLAN'] ?? null;
  });
}
