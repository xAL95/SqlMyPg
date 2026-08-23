import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addColumn, addConstraint, createIndex, createTable, dropColumn, dropConstraint, dropIndex,
  defaultConstraintName, defaultIndexName,
  ident, literal, renameColumn, renameTable, setColumnType, setDefault, setNotNull,
} from './ddl.js';

const t = { schema: 'shop', name: 'customers' };

test('identifiers are always quoted, and embedded quotes doubled', () => {
  assert.equal(ident('plain'), '"plain"');
  assert.equal(ident('MixedCase'), '"MixedCase"');
  // an identifier is the one place a name could otherwise escape into SQL
  assert.equal(ident('a" DROP TABLE x --'), '"a"" DROP TABLE x --"');
  assert.equal(literal("O'Brien"), "'O''Brien'");
});

test('create table declares a single primary key inline', () => {
  assert.equal(
    createTable(t, [
      { name: 'id', type: 'bigserial', primaryKey: true },
      { name: 'email', type: 'text', notNull: true },
      { name: 'seen', type: 'timestamptz', defaultExpr: 'now()' },
    ]),
    'CREATE TABLE "shop"."customers" (\n' +
      '  "id" bigserial PRIMARY KEY,\n' +
      '  "email" text NOT NULL,\n' +
      '  "seen" timestamptz DEFAULT now()\n' +
      ');',
  );
});

test('a composite primary key becomes one table-level constraint', () => {
  const sql = createTable({ schema: 's', name: 'li' }, [
    { name: 'order_id', type: 'bigint', primaryKey: true },
    { name: 'line_no', type: 'int', primaryKey: true },
  ]);
  assert.match(sql, /PRIMARY KEY \("order_id", "line_no"\)/);
  // exactly one PRIMARY KEY in the statement, never one per column
  assert.equal(sql.match(/PRIMARY KEY/g)?.length, 1);
});

test('columns with no name or type are dropped, and an empty table is refused', () => {
  const sql = createTable(t, [{ name: 'id', type: 'int' }, { name: '', type: 'text' }, { name: 'x', type: ' ' }]);
  assert.equal(sql, 'CREATE TABLE "shop"."customers" (\n  "id" int\n);');
  assert.throws(() => createTable(t, [{ name: '', type: '' }]), /at least one column/);
});

test('IF NOT EXISTS is opt-in', () => {
  assert.match(createTable({ ...t, ifNotExists: true }, [{ name: 'a', type: 'int' }]), /^CREATE TABLE IF NOT EXISTS/);
});

test('column operations', () => {
  assert.equal(addColumn(t, { name: 'note', type: 'text' }), 'ALTER TABLE "shop"."customers" ADD COLUMN "note" text;');
  assert.equal(
    addColumn(t, { name: 'n', type: 'int', notNull: true, defaultExpr: '0' }),
    'ALTER TABLE "shop"."customers" ADD COLUMN "n" int NOT NULL DEFAULT 0;',
  );
  assert.equal(renameColumn(t, 'a', 'b'), 'ALTER TABLE "shop"."customers" RENAME COLUMN "a" TO "b";');
  assert.equal(dropColumn(t, 'a'), 'ALTER TABLE "shop"."customers" DROP COLUMN "a";');
  assert.equal(dropColumn(t, 'a', true), 'ALTER TABLE "shop"."customers" DROP COLUMN "a" CASCADE;');
  assert.equal(renameTable(t, 'clients'), 'ALTER TABLE "shop"."customers" RENAME TO "clients";');
});

test('a type change always carries a USING cast', () => {
  assert.equal(
    setColumnType(t, 'age', 'int'),
    'ALTER TABLE "shop"."customers" ALTER COLUMN "age" TYPE int USING "age"::int;',
  );
  // a hand-written cast wins, for the times the default one will not do
  assert.match(setColumnType(t, 'age', 'int', 'nullif(age, 0)::int'), /USING nullif\(age, 0\)::int;$/);
});

test('not null and default toggle in both directions', () => {
  assert.match(setNotNull(t, 'a', true), /ALTER COLUMN "a" SET NOT NULL;$/);
  assert.match(setNotNull(t, 'a', false), /ALTER COLUMN "a" DROP NOT NULL;$/);
  assert.match(setDefault(t, 'a', 'now()'), /ALTER COLUMN "a" SET DEFAULT now\(\);$/);
  // an empty expression means "no default", which is DROP and not SET DEFAULT ''
  assert.match(setDefault(t, 'a', '   '), /ALTER COLUMN "a" DROP DEFAULT;$/);
});

test('constraints', () => {
  assert.equal(
    addConstraint(t, { kind: 'primaryKey', name: 'customers_pkey', columns: ['id'] }),
    'ALTER TABLE "shop"."customers" ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");',
  );
  assert.match(addConstraint(t, { kind: 'unique', name: 'u', columns: ['a', 'b'] }), /UNIQUE \("a", "b"\);$/);
  assert.match(addConstraint(t, { kind: 'check', name: 'c', expression: 'qty > 0' }), /CHECK \(qty > 0\);$/);
  assert.equal(
    addConstraint(t, {
      kind: 'foreignKey', name: 'fk', columns: ['order_id'],
      refSchema: 'shop', refTable: 'orders', refColumns: ['id'], onDelete: 'CASCADE',
    }),
    'ALTER TABLE "shop"."customers" ADD CONSTRAINT "fk" FOREIGN KEY ("order_id")' +
      ' REFERENCES "shop"."orders" ("id") ON DELETE CASCADE;',
  );
  assert.equal(dropConstraint(t, 'fk', true), 'ALTER TABLE "shop"."customers" DROP CONSTRAINT "fk" CASCADE;');
});

test('indexes', () => {
  assert.equal(
    createIndex(t, { name: 'ix_email', columns: ['email'] }),
    'CREATE INDEX "ix_email" ON "shop"."customers" ("email");',
  );
  assert.equal(
    createIndex(t, { name: 'ix', columns: ['a'], unique: true, method: 'btree', where: 'a IS NOT NULL' }),
    'CREATE UNIQUE INDEX "ix" ON "shop"."customers" USING btree ("a") WHERE a IS NOT NULL;',
  );
  // an index is dropped by its own schema-qualified name, not the table's
  assert.equal(dropIndex('shop', 'ix_email'), 'DROP INDEX "shop"."ix_email";');
});

test('generated names follow the conventions Postgres uses itself', () => {
  assert.equal(defaultConstraintName('customers', 'primaryKey', ['id']), 'customers_pkey');
  assert.equal(defaultConstraintName('customers', 'unique', ['email']), 'customers_email_key');
  assert.equal(defaultConstraintName('li', 'unique', ['order_id', 'line_no']), 'li_order_id_line_no_key');
  assert.equal(defaultConstraintName('li', 'foreignKey', ['order_id']), 'li_order_id_fkey');
  assert.equal(defaultConstraintName('li', 'check', ['qty']), 'li_qty_check');
  assert.equal(defaultIndexName('customers', ['email']), 'customers_email_idx');
  // no columns picked yet: still a usable name rather than a dangling underscore
  assert.equal(defaultConstraintName('t', 'unique', []), 't_key');
  assert.equal(defaultIndexName('t', ['']), 't_idx');
});

test('generated names are truncated to the identifier limit', () => {
  const name = defaultIndexName('t'.repeat(60), ['col']);
  assert.equal(name.length, 63, 'Postgres would silently truncate anything longer');
});
