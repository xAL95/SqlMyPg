import type { BrowseRequest, BrowseResponse, FieldMeta, RelationByOid, Row } from '@shared/protocol.js';
import type { TargetConfig } from './pool.js';
import { withPooled } from './pool.js';
import { quoteIdent, quoteQualified, REL_KIND } from './introspect.js';
import { splitStatements } from './sqlSplit.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

const httpError = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode });

type OrderKey = { column: string; desc: boolean };

/**
 * What a grid write did. `sql` keeps its placeholders - it is the statement Postgres actually
 * ran - and `params` are the values that were bound to them, so the caller can log a readable
 * form without the values ever having been part of the SQL text.
 */
/**
 * Tag a failed write with the statement that caused it. A Postgres error says what went wrong but
 * not what was run, and the route layer wants both for the history entry it writes either way.
 */
function tagSql<T>(sql: string, params: (string | null)[], run: () => Promise<T>): Promise<T> {
  return run().catch((e: unknown) => {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { sqlText: sql, sqlParams: params });
  });
}

type WriteResult = {
  rowCount: number;
  sql: string;
  params: (string | null)[];
};

export type Resolved = {
  schema: string;
  name: string;
  relkind: string;
  estimatedRows: number;
  columns: { name: string; attnum: number }[];
  /** attnums of the best unique key: primary key, else narrowest unique non-partial index */
  keyAttnums: number[];
};

/**
 * The same lookup as resolveRelation, addressed by oid and batched.
 *
 * A query result carries a tableOid per column and nothing else, so this is what turns "column 3
 * came from relation 16482" into a table, a column list and a key. It is read-only catalog access;
 * whether an UPDATE is actually allowed is decided by updateCell, which re-resolves the relation
 * from schema and name and refuses anything that does not match its own key exactly. The client's
 * inference can therefore only ever offer an edit, never authorise one.
 */
export async function resolveByOids(cfg: TargetConfig, oids: number[]): Promise<RelationByOid[]> {
  const wanted = [...new Set(oids.filter((o) => Number.isInteger(o) && o > 0))];
  if (!wanted.length) return [];
  return withPooled(cfg, async (c) => {
    const res = await c.query<{
      oid: string;
      schema: string;
      name: string;
      kind: RelationByOid['kind'];
      columns: { name: string; attnum: number }[];
      indkey: string | null;
      indnkeyatts: number | null;
    }>(
      // oid is unsigned 32-bit, so it comes back as text and is parsed here rather than risking
      // an int4 overflow on a cluster with high oids.
      `SELECT c.oid::text AS oid,
              n.nspname AS schema,
              c.relname AS name,
              ${REL_KIND} AS kind,
              (SELECT COALESCE(json_agg(json_build_object('name', a.attname, 'attnum', a.attnum)
                                        ORDER BY a.attnum), '[]'::json)
                 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
              k.indkey::text AS indkey,
              k.indnkeyatts AS indnkeyatts
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN LATERAL (
              SELECT i.indkey, i.indnkeyatts
                FROM pg_catalog.pg_index i
               WHERE i.indrelid = c.oid AND i.indisunique AND i.indisvalid
                 AND i.indpred IS NULL AND i.indexprs IS NULL
               ORDER BY i.indisprimary DESC, i.indnkeyatts, i.indexrelid
               LIMIT 1) k ON true
        WHERE c.oid = ANY($1::oid[])`,
      [wanted],
    );
    return res.rows.map((r) => ({
      oid: Number(r.oid),
      schema: r.schema,
      name: r.name,
      kind: r.kind,
      columns: r.columns,
      keyAttnums:
        r.indkey && r.indnkeyatts
          ? r.indkey.trim().split(/\s+/).slice(0, r.indnkeyatts).map(Number)
          : [],
    }));
  });
}

/** Catalog lookup only: identifiers used in the generated SQL come from here, never from the request. */
export async function resolveRelation(cfg: TargetConfig, schema: string, name: string): Promise<Resolved> {
  return withPooled(cfg, async (c) => {
    const rel = await c.query<{
      oid: number;
      schema: string;
      name: string;
      relkind: string;
      estimatedRows: number;
      columns: { name: string; attnum: number }[];
    }>(
      `SELECT c.oid AS oid,
              n.nspname AS schema,
              c.relname AS name,
              c.relkind::text AS relkind,
              GREATEST(c.reltuples, 0)::float8 AS "estimatedRows",
              (SELECT COALESCE(json_agg(json_build_object('name', a.attname, 'attnum', a.attnum)
                                        ORDER BY a.attnum), '[]'::json)
                 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'v', 'm', 'p', 'f')`,
      [schema, name],
    );
    const row = rel.rows[0];
    if (!row) throw httpError(404, `relation ${quoteQualified(schema, name)} does not exist`);

    // indkey is an int2vector; its text form ("1 3 2") is easier to trust than casting it to
    // an array, and the attnums are resolved against the column list we already have.
    const key = await c.query<{ indkey: string; indnkeyatts: number }>(
      `SELECT i.indkey::text AS indkey, i.indnkeyatts
         FROM pg_catalog.pg_index i
        WHERE i.indrelid = $1 AND i.indisunique AND i.indisvalid
          AND i.indpred IS NULL AND i.indexprs IS NULL
        ORDER BY i.indisprimary DESC, i.indnkeyatts, i.indexrelid
        LIMIT 1`,
      [row.oid],
    );
    const k = key.rows[0];
    return {
      schema: row.schema,
      name: row.name,
      relkind: row.relkind,
      estimatedRows: Math.round(row.estimatedRows),
      columns: row.columns,
      keyAttnums: k ? k.indkey.trim().split(/\s+/).slice(0, k.indnkeyatts).map(Number) : [],
    };
  });
}

/** Single-statement guard shared by browse and export - see the ponytail note in browse(). */
function checkWhere(where: string): string {
  if (splitStatements(where).length !== 1) throw httpError(400, 'where must be a single expression');
  return `(${where.trim()})`;
}

/**
 * The SELECT behind a whole-relation CSV export, with the browser's filter and sort applied.
 * Export must not silently ignore the WHERE the user is looking at - that hands them a file
 * with the wrong rows. No ORDER BY unless one was asked for: sorting a billion-row table to
 * write a CSV is not something to do by default.
 */
export async function tableSelect(
  cfg: TargetConfig,
  req: Pick<BrowseRequest, 'schema' | 'name' | 'where' | 'orderBy'>,
): Promise<string> {
  const rel = await resolveRelation(cfg, req.schema, req.name);
  const colNames = new Set(rel.columns.map((c) => c.name));
  const order = (req.orderBy ?? []).map((o) => {
    if (!colNames.has(o.column)) {
      throw httpError(400, `${JSON.stringify(o.column)} is not a column of this relation`);
    }
    return quoteIdent(o.column) + (o.desc ? ' DESC' : '');
  });
  return (
    `SELECT * FROM ${quoteQualified(rel.schema, rel.name)}` +
    (req.where && req.where.trim() ? ` WHERE ${checkWhere(req.where)}` : '') +
    (order.length ? ` ORDER BY ${order.join(', ')}` : '')
  );
}

export async function browse(cfg: TargetConfig, req: BrowseRequest): Promise<BrowseResponse> {
  const rel = await resolveRelation(cfg, req.schema, req.name);
  const colNames = new Set(rel.columns.map((c) => c.name));
  // ctid is the physical row id: unique inside a heap, so it works as a last-resort key for
  // ordinary and materialized tables, but not for views/foreign tables (no ctid at all) or
  // partitioned tables (ctid repeats across partitions, which would skip rows).
  const hasCtid = rel.relkind === 'r' || rel.relkind === 'm';

  const byAttnum = new Map(rel.columns.map((c) => [c.attnum, c.name]));
  const keyColumns = rel.keyAttnums.map((a) => byAttnum.get(a)).filter((c): c is string => c !== undefined);

  let order: OrderKey[];
  if (req.orderBy && req.orderBy.length > 0) {
    for (const o of req.orderBy) {
      if (!colNames.has(o.column) && !(hasCtid && o.column === 'ctid')) {
        throw httpError(400, `${JSON.stringify(o.column)} is not a column of this relation`);
      }
    }
    order = req.orderBy.map((o) => ({ column: o.column, desc: !!o.desc }));
  } else if (rel.keyAttnums.length > 0) {
    // Keyset pagination needs a unique, total ordering or it silently skips/repeats rows,
    // hence primary key -> narrowest unique non-partial index -> ctid.
    if (keyColumns.length !== rel.keyAttnums.length) {
      throw httpError(500, 'unique index references an unknown column');
    }
    order = keyColumns.map((column) => ({ column, desc: false }));
  } else if (hasCtid) {
    order = [{ column: 'ctid', desc: false }];
  } else {
    throw httpError(400, 'relation has no unique key; pass orderBy explicitly');
  }

  const rawLimit = req.limit ?? DEFAULT_LIMIT;
  if (!Number.isFinite(rawLimit)) throw httpError(400, 'limit must be a number');
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIMIT);

  const conds: string[] = [];
  const params: (string | null)[] = [];

  if (req.where && req.where.trim()) {
    // ponytail: this only stops a second command being smuggled into the predicate; the real
    // boundary is the Postgres role the connection uses, so read-only means a read-only role.
    conds.push(checkWhere(req.where));
  }

  const after = req.after;
  if (after && after.length > 0) {
    if (after.length !== order.length) {
      throw httpError(400, `after must have ${order.length} value(s) to match orderBy`);
    }
    const cols = order.map((o) => quoteIdent(o.column));
    const ph = after.map((v) => `$${params.push(v ?? null)}`);
    // Untyped parameters: Postgres infers each one from the column it is compared against.
    // ponytail: a NULL in a key column makes the comparison NULL and pagination stops there,
    // upgrade path is an IS NULL-aware OR chain per key column.
    if (order.every((o) => o.desc === order[0]!.desc)) {
      conds.push(`(${cols.join(', ')}) ${order[0]!.desc ? '<' : '>'} (${ph.join(', ')})`);
    } else {
      const chain = order.map((o, i) => {
        const eq = order.slice(0, i).map((_, j) => `${cols[j]} = ${ph[j]}`);
        eq.push(`${cols[i]} ${o.desc ? '<' : '>'} ${ph[i]}`);
        return `(${eq.join(' AND ')})`;
      });
      conds.push(`(${chain.join(' OR ')})`);
    }
  }

  // ctid is not part of `*`, so it is selected as a trailing extra and trimmed off the response.
  const hidden = [...new Set(order.map((o) => o.column).filter((c) => !colNames.has(c)))];
  const sql =
    `SELECT ${['*', ...hidden.map(quoteIdent)].join(', ')}` +
    ` FROM ${quoteQualified(rel.schema, rel.name)}` +
    (conds.length ? ` WHERE ${conds.join(' AND ')}` : '') +
    ` ORDER BY ${order.map((o) => quoteIdent(o.column) + (o.desc ? ' DESC' : '')).join(', ')}` +
    ` LIMIT ${limit + 1}`;

  return withPooled(
    cfg,
    async (c) => {
      const res = await c.query<Row>({ text: sql, values: params, rowMode: 'array' });

      const typeNames = new Map<number, string>();
      if (res.fields.length > 0) {
        const t = await c.query<{ oid: string; name: string }>(
          `SELECT t.oid::text AS oid, pg_catalog.format_type(t.oid, NULL) AS name
             FROM pg_catalog.pg_type t
            WHERE t.oid = ANY ($1::oid[])`,
          [[...new Set(res.fields.map((f) => f.dataTypeID))]],
        );
        for (const row of t.rows) typeNames.set(Number(row.oid), row.name);
      }

      const visible = res.fields.length - hidden.length;
      const fields: FieldMeta[] = res.fields.slice(0, visible).map((f) => ({
        name: f.name,
        dataTypeId: f.dataTypeID,
        typeName: typeNames.get(f.dataTypeID) ?? String(f.dataTypeID),
        tableOid: f.tableID,
        columnId: f.columnID,
      }));

      const done = res.rows.length <= limit;
      const kept = res.rows.slice(0, limit);
      const last = kept[kept.length - 1];
      const keyIdx = order.map((o) => res.fields.findIndex((f) => f.name === o.column));

      return {
        fields,
        rows: hidden.length ? kept.map((r) => r.slice(0, visible)) : kept,
        orderBy: order,
        cursorKey: last ? keyIdx.map((i) => (i < 0 ? null : last[i] ?? null)) : null,
        done,
        estimatedRows: rel.estimatedRows,
        sql,
        keyColumns,
      };
    },
    { raw: true },
  );
}

/**
 * INSERT one row and report how many landed. Column names are matched against the catalog
 * lookup in `resolve` and quoted from it, so nothing from the request reaches the SQL text;
 * values go over as bound parameters, which also lets Postgres do the casting - a text `$1`
 * against an int/timestamp/bool column is coerced by the server, so this never guesses types.
 *
 * Columns the caller omits are left out of the statement entirely, so the column default,
 * identity sequence or NULL applies.
 */
export async function insertRow(
  cfg: TargetConfig,
  req: { schema: string; name: string; values: Record<string, string | null> },
): Promise<WriteResult> {
  const rel = await resolveRelation(cfg, req.schema, req.name);
  const colNames = new Set(rel.columns.map((c) => c.name));
  const entries = Object.entries(req.values);
  for (const [col] of entries) {
    if (!colNames.has(col)) {
      throw httpError(400, `${JSON.stringify(col)} is not a column of this relation`);
    }
  }

  const into = quoteQualified(rel.schema, rel.name);
  const sql =
    entries.length === 0
      ? `INSERT INTO ${into} DEFAULT VALUES`
      : `INSERT INTO ${into} (${entries.map(([c]) => quoteIdent(c)).join(', ')})` +
        ` VALUES (${entries.map((_, i) => `$${i + 1}`).join(', ')})`;

  const params = entries.map(([, v]) => v);
  return withPooled(cfg, (c) =>
    tagSql(sql, params, async () => {
      const res = await c.query(sql, params);
      return { rowCount: res.rowCount ?? 0, sql, params };
    }),
  );
}

/**
 * DELETE the rows addressed by their unique-key values, in one statement.
 *
 * Only the relation's own unique key is accepted. A table with no unique key browses by ctid,
 * and a ctid is not an identity: VACUUM or an UPDATE moves a live row to a new one, and a
 * later INSERT can reuse the old one - so a ctid captured when the page was loaded could by
 * now address a different row. Refusing is the only safe answer; those rows are deletable from
 * the SQL editor, where the user writes the predicate and owns it.
 *
 * Every key value is a bound parameter and every identifier comes from the catalog, so the
 * statement shape is fixed no matter what the request contains.
 */
export async function deleteRows(
  cfg: TargetConfig,
  req: { schema: string; name: string; keys: Record<string, string | null>[] },
): Promise<WriteResult> {
  if (req.keys.length === 0) return { rowCount: 0, sql: '', params: [] };

  const rel = await resolveRelation(cfg, req.schema, req.name);
  const byAttnum = new Map(rel.columns.map((c) => [c.attnum, c.name]));
  const keyColumns = rel.keyAttnums.map((a) => byAttnum.get(a)).filter((c): c is string => c !== undefined);
  if (keyColumns.length === 0 || keyColumns.length !== rel.keyAttnums.length) {
    throw httpError(
      400,
      `${quoteQualified(rel.schema, rel.name)} has no unique key, so a row cannot be addressed safely; ` +
        'delete from the SQL editor with a WHERE you control',
    );
  }

  // Each row must supply exactly the key, or it is not the row the caller thinks it is.
  for (const k of req.keys) {
    const got = Object.keys(k);
    if (got.length !== keyColumns.length || keyColumns.some((c) => !(c in k))) {
      throw httpError(400, `each row must be identified by exactly its key (${keyColumns.join(', ')})`);
    }
  }

  const params: (string | null)[] = [];
  const tuples = req.keys.map((k) => {
    const ph = keyColumns.map((c) => {
      params.push(k[c] ?? null);
      return `$${params.length}`;
    });
    return `(${ph.join(', ')})`;
  });

  const cols = keyColumns.map(quoteIdent).join(', ');
  const sql =
    `DELETE FROM ${quoteQualified(rel.schema, rel.name)}` +
    ` WHERE (${cols}) IN (${tuples.join(', ')})`;

  return withPooled(cfg, (c) =>
    tagSql(sql, params, async () => {
      const res = await c.query(sql, params);
      return { rowCount: res.rowCount ?? 0, sql, params };
    }),
  );
}

/**
 * UPDATE one column of one row, addressed by the same unique key that deleteRows requires and
 * for the same reason: a ctid is not an identity, so a table without a key is not editable here.
 *
 * The column name is matched against the catalog and quoted from it; the new value and every key
 * value are bound parameters, so Postgres casts the text to the column type instead of this code
 * guessing it. A key column may itself be edited - the WHERE still uses the value the row had
 * when it was read, which is the row the user was looking at.
 */
export async function updateCell(
  cfg: TargetConfig,
  req: {
    schema: string;
    name: string;
    key: Record<string, string | null>;
    column: string;
    value: string | null;
  },
): Promise<WriteResult & { value: string | null }> {
  const rel = await resolveRelation(cfg, req.schema, req.name);
  const byAttnum = new Map(rel.columns.map((c) => [c.attnum, c.name]));
  const keyColumns = rel.keyAttnums.map((a) => byAttnum.get(a)).filter((c): c is string => c !== undefined);
  if (keyColumns.length === 0 || keyColumns.length !== rel.keyAttnums.length) {
    throw httpError(
      400,
      `${quoteQualified(rel.schema, rel.name)} has no unique key, so a row cannot be addressed safely; ` +
        'edit it from the SQL editor with a WHERE you control',
    );
  }
  if (!rel.columns.some((c) => c.name === req.column)) {
    throw httpError(400, `${JSON.stringify(req.column)} is not a column of this relation`);
  }
  const got = Object.keys(req.key);
  if (got.length !== keyColumns.length || keyColumns.some((c) => !(c in req.key))) {
    throw httpError(400, `the row must be identified by exactly its key (${keyColumns.join(', ')})`);
  }

  const params: (string | null)[] = [req.value];
  const where = keyColumns.map((c) => {
    params.push(req.key[c] ?? null);
    return `${quoteIdent(c)} = $${params.length}`;
  });

  // RETURNING the column reports what Postgres actually stored, which is not always what was
  // sent: a domain, a trigger or a type's own input conversion can change it. The client patches
  // its cached row with this rather than with the text the user typed.
  const sql =
    `UPDATE ${quoteQualified(rel.schema, rel.name)}` +
    ` SET ${quoteIdent(req.column)} = $1` +
    ` WHERE ${where.join(' AND ')}` +
    ` RETURNING ${quoteIdent(req.column)}`;

  return withPooled(
    cfg,
    (c) =>
      tagSql(sql, params, async () => {
        const res = await c.query<Row>({ text: sql, values: params, rowMode: 'array' });
        return { rowCount: res.rowCount ?? 0, value: res.rows[0]?.[0] ?? null, sql, params };
      }),
    { raw: true },
  );
}
