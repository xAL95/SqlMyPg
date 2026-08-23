import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineParams } from './queryHistory.js';

test('parameters are substituted by position', () => {
  assert.equal(
    inlineParams('UPDATE t SET a = $1 WHERE id = $2', ['x', '7']),
    "UPDATE t SET a = 'x' WHERE id = '7'",
  );
});

test('null becomes NULL, not a quoted empty string', () => {
  assert.equal(inlineParams('UPDATE t SET a = $1', [null]), 'UPDATE t SET a = NULL');
  assert.equal(inlineParams('UPDATE t SET a = $1', ['']), "UPDATE t SET a = ''");
});

test('quotes in a value are doubled, so the literal cannot be escaped', () => {
  assert.equal(inlineParams('SET a = $1', ["O'Brien"]), "SET a = 'O''Brien'");
  assert.equal(inlineParams('SET a = $1', ["'; DROP TABLE t; --"]), "SET a = '''; DROP TABLE t; --'");
});

test('two-digit placeholders are not confused with single-digit ones', () => {
  const params = Array.from({ length: 12 }, (_, i) => String(i + 1));
  assert.equal(inlineParams('VALUES ($1, $2, $11, $12)', params), "VALUES ('1', '2', '11', '12')");
});

test('a placeholder with no parameter is left alone rather than dropped', () => {
  assert.equal(inlineParams('SET a = $1, b = $2', ['only']), "SET a = 'only', b = $2");
});
