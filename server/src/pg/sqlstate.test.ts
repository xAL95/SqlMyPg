import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSUFFICIENT_PRIVILEGE, pgSqlstate } from './sqlstate.js';

const pgErr = (code: string) => Object.assign(new Error('boom'), { code, severity: 'ERROR' });

test('pgSqlstate keeps real Postgres errors', () => {
  assert.equal(pgSqlstate(pgErr(INSUFFICIENT_PRIVILEGE)), '42501');
  assert.equal(pgSqlstate(pgErr('42P01')), '42P01'); // undefined_table
  assert.equal(pgSqlstate(pgErr('3D000')), '3D000'); // invalid_catalog_name
});

test('pgSqlstate rejects everything that is not a Postgres error', () => {
  // a node syscall error: 5 uppercase chars in `code`, but no severity
  assert.equal(pgSqlstate(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })), undefined);
  assert.equal(pgSqlstate(pgErr('XX000')), undefined); // internal_error stays a 500
  assert.equal(pgSqlstate(new Error('plain')), undefined);
  assert.equal(pgSqlstate(null), undefined);
  assert.equal(pgSqlstate(undefined), undefined);
});
