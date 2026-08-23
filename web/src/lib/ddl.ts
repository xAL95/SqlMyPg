/**
 * DDL builders for the schema tree. Pure string building on purpose: the statements land in a
 * query tab for the user to read and run, so they go through the same session, transaction,
 * read-only guard and history as anything else typed by hand. Nothing here talks to the server.
 *
 * Identifiers are always quoted. Postgres folds an unquoted identifier to lower case, so quoting
 * is what makes a generated statement work for MixedCase and for anything holding a space.
 */

/** Quote an identifier, doubling any embedded quote. */
export const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const qualified = (schema: string, name: string) => `${ident(schema)}.${ident(name)}`;

/** A single-quoted literal, for DEFAULT expressions the user typed as a plain value. */
export const literal = (v: string) => `'${v.replaceAll("'", "''")}'`;

export type NewColumn = {
  name: string;
  /** a type name as Postgres spells it, e.g. `text`, `numeric(12,2)`, `timestamptz` */
  type: string;
  notNull?: boolean;
  primaryKey?: boolean;
  /** raw SQL, not a literal - `now()` and `0` are both expected to work */
  defaultExpr?: string;
};

/**
 * CREATE TABLE. A single primary-key column is declared inline; several become a table-level
 * PRIMARY KEY so a composite key comes out as one constraint rather than an invalid statement.
 */
export function createTable(
  table: { schema: string; name: string; ifNotExists?: boolean },
  columns: NewColumn[],
): string {
  const usable = columns.filter((c) => c.name.trim() !== '' && c.type.trim() !== '');
  if (usable.length === 0) throw new Error('a table needs at least one column');

  const pk = usable.filter((c) => c.primaryKey);
  const lines = usable.map((c) => {
    let line = `  ${ident(c.name)} ${c.type.trim()}`;
    // a lone primary key implies NOT NULL, so saying both is noise
    if (pk.length === 1 && c.primaryKey) line += ' PRIMARY KEY';
    else if (c.notNull) line += ' NOT NULL';
    if (c.defaultExpr && c.defaultExpr.trim() !== '') line += ` DEFAULT ${c.defaultExpr.trim()}`;
    return line;
  });
  if (pk.length > 1) lines.push(`  PRIMARY KEY (${pk.map((c) => ident(c.name)).join(', ')})`);

  const head = table.ifNotExists ? 'CREATE TABLE IF NOT EXISTS' : 'CREATE TABLE';
  return `${head} ${qualified(table.schema, table.name)} (\n${lines.join(',\n')}\n);`;
}

type Table = { schema: string; name: string };

const alter = (t: Table) => `ALTER TABLE ${qualified(t.schema, t.name)}`;

export const addColumn = (t: Table, c: NewColumn): string => {
  let s = `${alter(t)} ADD COLUMN ${ident(c.name)} ${c.type.trim()}`;
  if (c.notNull) s += ' NOT NULL';
  if (c.defaultExpr && c.defaultExpr.trim() !== '') s += ` DEFAULT ${c.defaultExpr.trim()}`;
  return `${s};`;
};

export const renameColumn = (t: Table, from: string, to: string) =>
  `${alter(t)} RENAME COLUMN ${ident(from)} TO ${ident(to)};`;

export const dropColumn = (t: Table, column: string, cascade?: boolean) =>
  `${alter(t)} DROP COLUMN ${ident(column)}${cascade ? ' CASCADE' : ''};`;

export const renameTable = (t: Table, to: string) => `${alter(t)} RENAME TO ${ident(to)};`;

/**
 * A type change needs a cast for any existing row, and Postgres only applies one implicitly for
 * a few pairs. The USING clause is always emitted so the statement is honest about what it does
 * to the data already there, and stays editable if the default cast is not the right one.
 */
export const setColumnType = (t: Table, column: string, type: string, using?: string) => {
  const cast = using && using.trim() !== '' ? using.trim() : `${ident(column)}::${type.trim()}`;
  return `${alter(t)} ALTER COLUMN ${ident(column)} TYPE ${type.trim()} USING ${cast};`;
};

export const setNotNull = (t: Table, column: string, notNull: boolean) =>
  `${alter(t)} ALTER COLUMN ${ident(column)} ${notNull ? 'SET' : 'DROP'} NOT NULL;`;

/** An empty expression drops the default rather than setting it to nothing. */
export const setDefault = (t: Table, column: string, expr: string) =>
  expr.trim() === ''
    ? `${alter(t)} ALTER COLUMN ${ident(column)} DROP DEFAULT;`
    : `${alter(t)} ALTER COLUMN ${ident(column)} SET DEFAULT ${expr.trim()};`;

export type ConstraintSpec =
  | { kind: 'primaryKey'; name: string; columns: string[] }
  | { kind: 'unique'; name: string; columns: string[] }
  | { kind: 'check'; name: string; expression: string }
  | {
      kind: 'foreignKey';
      name: string;
      columns: string[];
      refSchema: string;
      refTable: string;
      refColumns: string[];
      onDelete?: string;
      onUpdate?: string;
    };

export function addConstraint(t: Table, spec: ConstraintSpec): string {
  const head = `${alter(t)} ADD CONSTRAINT ${ident(spec.name)}`;
  const cols = (c: string[]) => c.map(ident).join(', ');
  switch (spec.kind) {
    case 'primaryKey':
      return `${head} PRIMARY KEY (${cols(spec.columns)});`;
    case 'unique':
      return `${head} UNIQUE (${cols(spec.columns)});`;
    case 'check':
      return `${head} CHECK (${spec.expression.trim()});`;
    case 'foreignKey': {
      let s =
        `${head} FOREIGN KEY (${cols(spec.columns)})` +
        ` REFERENCES ${qualified(spec.refSchema, spec.refTable)} (${cols(spec.refColumns)})`;
      if (spec.onDelete) s += ` ON DELETE ${spec.onDelete}`;
      if (spec.onUpdate) s += ` ON UPDATE ${spec.onUpdate}`;
      return `${s};`;
    }
  }
}

export const dropConstraint = (t: Table, name: string, cascade?: boolean) =>
  `${alter(t)} DROP CONSTRAINT ${ident(name)}${cascade ? ' CASCADE' : ''};`;

/** An index lives in its table's schema, so only its own name is given. */
export function createIndex(
  t: Table,
  spec: { name: string; columns: string[]; unique?: boolean; method?: string; where?: string },
): string {
  let s = spec.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
  s += ` ${ident(spec.name)} ON ${qualified(t.schema, t.name)}`;
  if (spec.method && spec.method.trim() !== '') s += ` USING ${spec.method.trim()}`;
  s += ` (${spec.columns.map(ident).join(', ')})`;
  if (spec.where && spec.where.trim() !== '') s += ` WHERE ${spec.where.trim()}`;
  return `${s};`;
}

export const dropIndex = (schema: string, name: string, cascade?: boolean) =>
  `DROP INDEX ${qualified(schema, name)}${cascade ? ' CASCADE' : ''};`;

/**
 * The name Postgres would pick itself, so the dialogs can prefill it instead of demanding the
 * user invent one. Postgres truncates identifiers at 63 bytes, and so does this.
 */
const trim63 = (s: string) => (s.length <= 63 ? s : s.slice(0, 63));

export function defaultConstraintName(table: string, kind: ConstraintSpec['kind'], columns: string[]): string {
  const cols = columns.filter((c) => c !== '').join('_');
  switch (kind) {
    case 'primaryKey':
      return trim63(`${table}_pkey`);
    case 'unique':
      return trim63(cols ? `${table}_${cols}_key` : `${table}_key`);
    case 'foreignKey':
      return trim63(cols ? `${table}_${cols}_fkey` : `${table}_fkey`);
    case 'check':
      return trim63(cols ? `${table}_${cols}_check` : `${table}_check`);
  }
}

export function defaultIndexName(table: string, columns: string[]): string {
  const cols = columns.filter((c) => c !== '').join('_');
  return trim63(cols ? `${table}_${cols}_idx` : `${table}_idx`);
}
