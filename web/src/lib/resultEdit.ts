import type { FieldMeta, RelationByOid, Row } from '@shared/protocol';

/**
 * Deciding whether one column of an arbitrary query result can be written back.
 *
 * Postgres puts `tableOid` and `columnId` (attnum) on a result column only when that column is a
 * plain reference to a stored column. An expression, an aggregate, a set operation or a value from
 * a VALUES list reports 0, so those can never be mistaken for something editable.
 *
 * That alone is not enough. Two further conditions have to hold, and both are about identity
 * rather than permission:
 *
 *  - the relation must be an ordinary or partitioned table, because that is what UPDATE addresses;
 *  - every column of the table's unique key must be present in the result, so the row the user is
 *    looking at can be named exactly. Without the full key there is no way to write to one row and
 *    only one row, and a ctid is not an identity.
 *
 * Requiring the full key is also what makes a grouped or joined result safe: if the key is in the
 * projection then one result row corresponds to one table row, whatever the query did around it.
 *
 * None of this authorises anything. The server's updateCell re-resolves the relation from its
 * schema and name and re-derives the key from the catalog, refusing any request that does not match
 * exactly, so this module can only offer an edit the server would independently allow.
 */
export type EditTarget = {
  schema: string;
  table: string;
  /** the stored column name, which is not the result label when the query aliased it */
  column: string;
  keyColumns: string[];
  /** result column index of each key column, in key order */
  keyIndexes: number[];
};

export type EditVerdict = { target: EditTarget } | { reason: string };

const KIND_NAME: Record<string, string> = {
  view: 'view',
  matview: 'materialized view',
  foreign: 'foreign table',
};

/** The relations a result set draws from, for one lookup instead of one per column. */
export function tableOids(fields: FieldMeta[]): number[] {
  return [...new Set(fields.map((f) => f.tableOid).filter((o) => o > 0))];
}

export function editTarget(
  fields: FieldMeta[],
  columnIndex: number,
  relations: Map<number, RelationByOid>,
): EditVerdict {
  const f = fields[columnIndex];
  if (!f) return { reason: 'This column is not part of the result.' };

  if (f.tableOid === 0 || f.columnId <= 0) {
    return { reason: 'This value is computed by the query, so there is no stored cell behind it.' };
  }

  const rel = relations.get(f.tableOid);
  if (!rel) return { reason: 'The table this column came from could not be resolved.' };

  if (rel.kind !== 'table' && rel.kind !== 'partitioned') {
    const kind = KIND_NAME[rel.kind] ?? rel.kind;
    return {
      reason: `${rel.schema}.${rel.name} is a ${kind}; only an ordinary table can be edited from the grid.`,
    };
  }

  const byAttnum = new Map(rel.columns.map((c) => [c.attnum, c.name]));
  const column = byAttnum.get(f.columnId);
  if (!column) return { reason: 'This column no longer exists on the table.' };

  if (!rel.keyAttnums.length) {
    return {
      reason:
        `${rel.schema}.${rel.name} has no primary key or unique index, so a row cannot be addressed ` +
        'safely. Write an UPDATE with a WHERE you control instead.',
    };
  }

  const keyColumns = rel.keyAttnums.map((a) => byAttnum.get(a));
  if (keyColumns.some((n) => n === undefined)) {
    return { reason: `The key of ${rel.schema}.${rel.name} could not be read from the catalog.` };
  }

  // Matched on attnum, not on name: the result may have aliased the key column to something else.
  const keyIndexes = rel.keyAttnums.map((a) =>
    fields.findIndex((x) => x.tableOid === f.tableOid && x.columnId === a),
  );
  const missing = keyColumns.filter((_, i) => (keyIndexes[i] as number) < 0);
  if (missing.length) {
    return {
      reason:
        `Add ${missing.join(', ')} to the SELECT to edit ${rel.name}: a row can only be addressed ` +
        `by its whole key (${keyColumns.join(', ')}).`,
    };
  }

  return {
    target: { schema: rel.schema, table: rel.name, column, keyColumns: keyColumns as string[], keyIndexes },
  };
}

/** The key values as the row was read, which is how the server finds that one row again. */
export function keyOf(row: Row, t: EditTarget): Record<string, string | null> {
  return Object.fromEntries(t.keyColumns.map((c, i) => [c, row[t.keyIndexes[i] as number] ?? null]));
}
