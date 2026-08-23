import type { FieldMeta, Row } from '@shared/protocol';

/** RFC 4180: quote a field that contains a delimiter, a quote or a newline, and double its quotes. */
function csvField(v: string | null): string {
  if (v === null) return '';
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** CSV for the given rows, header first. NULL becomes an empty field, which CSV cannot distinguish. */
export function toCsv(fields: FieldMeta[], rows: Row[]): string {
  const lines = [fields.map((f) => csvField(f.name)).join(',')];
  for (const row of rows) lines.push(fields.map((_, i) => csvField(row[i] ?? null)).join(','));
  return lines.join('\n');
}

/** A single-quoted SQL literal. Doubling the quote is the whole escape; E'' strings are not used. */
function sqlLiteral(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replaceAll("'", "''")}'`;
}

const NEEDS_QUOTING = /^[a-z_][a-z0-9_$]*$/;

/** Quote an identifier only when Postgres would not fold it to itself unquoted. */
export function sqlIdent(name: string): string {
  return NEEDS_QUOTING.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/**
 * One INSERT per row, for pasting into the editor.
 *
 * Every non-NULL value is emitted as a quoted literal rather than a bare number: Postgres
 * coerces a string literal to the target column type in INSERT position, so this stays correct
 * for int, numeric, bool, timestamptz and json alike without the client guessing types.
 */
export function toSqlInsert(table: { schema: string; name: string }, fields: FieldMeta[], rows: Row[]): string {
  const into = `${sqlIdent(table.schema)}.${sqlIdent(table.name)}`;
  const cols = fields.map((f) => sqlIdent(f.name)).join(', ');
  return rows
    .map((row) => `INSERT INTO ${into} (${cols}) VALUES (${fields.map((_, i) => sqlLiteral(row[i] ?? null)).join(', ')});`)
    .join('\n');
}
