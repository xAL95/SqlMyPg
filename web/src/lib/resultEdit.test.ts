import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FieldMeta, RelationByOid } from '@shared/protocol';
import { editTarget, keyOf, tableOids } from './resultEdit.js';

const field = (name: string, tableOid: number, columnId: number): FieldMeta => ({
  name,
  dataTypeId: 25,
  typeName: 'text',
  tableOid,
  columnId,
});

/** events(id pk, kind, amount) at oid 100; audit(a, b) has no key, at oid 300 */
const EVENTS: RelationByOid = {
  oid: 100,
  schema: 'shop',
  name: 'events',
  kind: 'table',
  columns: [
    { name: 'id', attnum: 1 },
    { name: 'kind', attnum: 2 },
    { name: 'amount', attnum: 3 },
  ],
  keyAttnums: [1],
};
const CUSTOMERS: RelationByOid = {
  oid: 200,
  schema: 'shop',
  name: 'customers',
  kind: 'table',
  columns: [
    { name: 'tenant', attnum: 1 },
    { name: 'email', attnum: 2 },
    { name: 'name', attnum: 3 },
  ],
  keyAttnums: [1, 2],
};
const AUDIT: RelationByOid = {
  oid: 300,
  schema: 'shop',
  name: 'audit',
  kind: 'table',
  columns: [
    { name: 'a', attnum: 1 },
    { name: 'b', attnum: 2 },
  ],
  keyAttnums: [],
};
const REPORT: RelationByOid = { ...EVENTS, oid: 400, name: 'report', kind: 'view' };

const rels = new Map([
  [100, EVENTS],
  [200, CUSTOMERS],
  [300, AUDIT],
  [400, REPORT],
]);

test('a stored column with its key in the projection is editable', () => {
  // SELECT id, kind FROM shop.events
  const fields = [field('id', 100, 1), field('kind', 100, 2)];
  const v = editTarget(fields, 1, rels);
  assert.deepEqual(v, {
    target: { schema: 'shop', table: 'events', column: 'kind', keyColumns: ['id'], keyIndexes: [0] },
  });
});

test('the stored column name wins over the result label', () => {
  // SELECT id, kind AS what FROM shop.events - the UPDATE has to name "kind", not "what"
  const fields = [field('id', 100, 1), field('what', 100, 2)];
  const v = editTarget(fields, 1, rels);
  assert.equal('target' in v && v.target.column, 'kind');
});

test('a key found by attnum survives being aliased too', () => {
  // SELECT id AS pk, kind FROM shop.events
  const fields = [field('pk', 100, 1), field('kind', 100, 2)];
  const v = editTarget(fields, 1, rels);
  assert.equal('target' in v && v.target.keyColumns[0], 'id', 'the key is named as the table has it');
  assert.equal('target' in v && v.target.keyIndexes[0], 0, 'and located by where it sits in the result');
});

test('a computed column is never editable', () => {
  const fields = [field('id', 100, 1), field('total', 0, 0)];
  const v = editTarget(fields, 1, rels);
  assert.match('reason' in v ? v.reason : '', /computed by the query/);
});

test('the key must be present in full, and the missing part is named', () => {
  // SELECT name FROM shop.customers - the key is (tenant, email), neither is projected
  let v = editTarget([field('name', 200, 3)], 0, rels);
  assert.match('reason' in v ? v.reason : '', /Add tenant, email to the SELECT/);
  assert.match('reason' in v ? v.reason : '', /whole key \(tenant, email\)/);

  // half of a composite key is still not an identity
  v = editTarget([field('tenant', 200, 1), field('name', 200, 3)], 1, rels);
  assert.match('reason' in v ? v.reason : '', /Add email to the SELECT/);

  // both halves, in the wrong order in the projection: keyIndexes follow the key, not the result
  v = editTarget([field('email', 200, 2), field('name', 200, 3), field('tenant', 200, 1)], 1, rels);
  assert.deepEqual('target' in v && v.target.keyIndexes, [2, 0]);
});

test('a join gates each column on its own table', () => {
  // SELECT e.id, e.kind, c.name FROM events e JOIN customers c ...
  const fields = [field('id', 100, 1), field('kind', 100, 2), field('name', 200, 3)];
  assert.ok('target' in editTarget(fields, 1, rels), 'events has its key here');
  assert.match(
    'reason' in editTarget(fields, 2, rels) ? (editTarget(fields, 2, rels) as { reason: string }).reason : '',
    /Add tenant, email/,
    'customers does not, even though the other table does',
  );
});

test('a table with no unique key is refused', () => {
  const v = editTarget([field('a', 300, 1), field('b', 300, 2)], 1, rels);
  assert.match('reason' in v ? v.reason : '', /no primary key or unique index/);
});

test('a view is refused, and says what it is', () => {
  const v = editTarget([field('id', 400, 1), field('kind', 400, 2)], 1, rels);
  assert.match('reason' in v ? v.reason : '', /shop\.report is a view/);
});

test('an unresolved oid is refused rather than guessed at', () => {
  const v = editTarget([field('x', 999, 1)], 0, rels);
  assert.match('reason' in v ? v.reason : '', /could not be resolved/);
});

test('tableOids collects the relations worth looking up, once each', () => {
  const fields = [field('id', 100, 1), field('kind', 100, 2), field('name', 200, 3), field('n', 0, 0)];
  assert.deepEqual(tableOids(fields), [100, 200]);
  assert.deepEqual(tableOids([]), []);
});

test('the key is read off the row as it was fetched, NULL included', () => {
  const t = { schema: 's', table: 't', column: 'c', keyColumns: ['tenant', 'email'], keyIndexes: [2, 0] };
  assert.deepEqual(keyOf(['a@b.c', 'Ada', null], t), { tenant: null, email: 'a@b.c' });
});
