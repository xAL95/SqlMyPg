import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FieldMeta, Row } from '@shared/protocol';
import { sqlIdent, toCsv, toSqlInsert } from './rowFormat.js';

const f = (name: string): FieldMeta =>
  ({ name, dataTypeId: 25, typeName: 'text', tableOid: 0, columnId: 0 }) as FieldMeta;
const fields = [f('id'), f('note')];

test('csv quotes only what needs it and doubles inner quotes', () => {
  const rows: Row[] = [['1', 'plain'], ['2', 'has,comma'], ['3', 'say "hi"'], ['4', 'two\nlines'], ['5', null]];
  assert.equal(
    toCsv(fields, rows),
    ['id,note', '1,plain', '2,"has,comma"', '3,"say ""hi"""', '4,"two\nlines"', '5,'].join('\n'),
  );
});

test('sql insert escapes quotes and keeps NULL unquoted', () => {
  const rows: Row[] = [['1', "O'Brien"], ['2', null]];
  assert.equal(
    toSqlInsert({ schema: 'shop', name: 'customers' }, fields, rows),
    "INSERT INTO shop.customers (id, note) VALUES ('1', 'O''Brien');\n" +
      'INSERT INTO shop.customers (id, note) VALUES (\'2\', NULL);',
  );
});

test('a quote in a value cannot terminate the literal', () => {
  const out = toSqlInsert({ schema: 's', name: 't' }, [f('a')], [["'; DROP TABLE t; --"]]);
  assert.equal(out, `INSERT INTO s.t (a) VALUES ('''; DROP TABLE t; --');`);
});

test('identifiers are quoted only when Postgres would not fold them', () => {
  assert.equal(sqlIdent('plain_name'), 'plain_name');
  assert.equal(sqlIdent('MixedCase'), '"MixedCase"');
  assert.equal(sqlIdent('has space'), '"has space"');
  assert.equal(sqlIdent('we"ird'), '"we""ird"');
});
