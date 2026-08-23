import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsSimpleProtocol, returnsRows, splitStatements } from './sqlSplit.js';

test('a semicolon inside a single-quoted string does not split', () => {
  const stmts = splitStatements("SELECT 'a;b' AS x; SELECT 2");
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0]?.sql, "SELECT 'a;b' AS x");
  assert.equal(stmts[1]?.sql, 'SELECT 2');
});

test('a doubled quote does not end a string', () => {
  const stmts = splitStatements("SELECT 'it''s; fine' AS x; SELECT 2");
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0]?.sql, "SELECT 'it''s; fine' AS x");
});

test('a backslash-escaped quote ends nothing in an E-string', () => {
  const stmts = splitStatements("SELECT E'a\\';b' AS x; SELECT 2");
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0]?.sql, "SELECT E'a\\';b' AS x");
});

test('a semicolon inside a dollar-quoted body with a nested tag does not split', () => {
  const script = [
    'CREATE FUNCTION f() RETURNS void AS $body$',
    'BEGIN',
    '  EXECUTE $q$ SELECT 1; $q$;',
    "  RAISE NOTICE 'x;y';",
    'END',
    '$body$ LANGUAGE plpgsql;',
    'SELECT 1',
  ].join('\n');
  const stmts = splitStatements(script);
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0]?.sql.startsWith('CREATE FUNCTION'));
  assert.ok(stmts[0]?.sql.endsWith('$body$ LANGUAGE plpgsql'));
  assert.equal(stmts[1]?.sql, 'SELECT 1');
});

test('an unclosed dollar tag is not a dollar quote, so $1 params still split', () => {
  const stmts = splitStatements('SELECT $1; SELECT $2');
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0]?.sql, 'SELECT $1');
  assert.equal(stmts[1]?.sql, 'SELECT $2');
});

test('semicolons inside a line comment and a nested block comment do not split', () => {
  const script = 'SELECT 1 -- a; b\n/* c; /* d; */ e; */ + 2; SELECT 3';
  const stmts = splitStatements(script);
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0]?.sql, 'SELECT 1 -- a; b\n/* c; /* d; */ e; */ + 2');
  assert.equal(stmts[1]?.sql, 'SELECT 3');
});

test('a semicolon inside a quoted identifier does not split', () => {
  const stmts = splitStatements('SELECT "we;ird", "a""b;c" FROM t; SELECT 2');
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0]?.sql, 'SELECT "we;ird", "a""b;c" FROM t');
  assert.equal(stmts[1]?.sql, 'SELECT 2');
});

test('empty and comment-only statements are dropped', () => {
  assert.equal(splitStatements('-- nothing\n;;\n/* also nothing */').length, 0);
  assert.equal(splitStatements('   \n\t ').length, 0);
});

test('a trailing statement without a semicolon is returned', () => {
  const stmts = splitStatements('SELECT 1;\nSELECT 2');
  assert.equal(stmts.length, 2);
  assert.equal(stmts[1]?.sql, 'SELECT 2');
});

test('an unterminated string yields the rest of the script as the last statement', () => {
  const stmts = splitStatements("SELECT 1; SELECT 'oops; more");
  assert.equal(stmts.length, 2);
  assert.equal(stmts[1]?.sql, "SELECT 'oops; more");
});

test('an unterminated block comment yields the rest of the script as the last statement', () => {
  const stmts = splitStatements('SELECT 1; /* oops; SELECT 2');
  assert.equal(stmts.length, 2);
  assert.equal(stmts[1]?.sql, '/* oops; SELECT 2');
});

test('a transaction script splits into five statements with correct offsets', () => {
  const script = [
    'BEGIN;',
    'CREATE TEMP TABLE t (a int);',
    'INSERT INTO t VALUES (1);',
    'SELECT * FROM t;',
    'ROLLBACK;',
  ].join('\n');
  const stmts = splitStatements(script);
  assert.equal(stmts.length, 5);
  assert.deepEqual(
    stmts.map((s) => s.sql),
    ['BEGIN', 'CREATE TEMP TABLE t (a int)', 'INSERT INTO t VALUES (1)', 'SELECT * FROM t', 'ROLLBACK'],
  );
  assert.deepEqual(
    stmts.map((s) => s.firstWord),
    ['BEGIN', 'CREATE', 'INSERT', 'SELECT', 'ROLLBACK'],
  );
  assert.deepEqual(
    stmts.map((s) => s.offset),
    [
      script.indexOf('BEGIN'),
      script.indexOf('CREATE'),
      script.indexOf('INSERT'),
      script.indexOf('SELECT'),
      script.indexOf('ROLLBACK'),
    ],
  );
  assert.deepEqual(
    stmts.map((s) => s.returnsRows),
    [false, false, false, true, false],
  );
});

test('offsets point at the statement text inside the original script', () => {
  const script = "  -- lead\n  SELECT 'a;b';\n\n\t/* x */ VACUUM ANALYZE t;\n  SELECT \"c;d\" ;  \nSELECT 3  ";
  const stmts = splitStatements(script);
  assert.equal(stmts.length, 4);
  for (const s of stmts) assert.equal(script.slice(s.offset, s.offset + s.sql.length), s.sql);
  assert.equal(stmts[0]?.firstWord, 'SELECT');
  assert.equal(stmts[1]?.firstWord, 'VACUUM');
});

test('a leading open paren is skipped when finding the first word', () => {
  const stmts = splitStatements('(SELECT 1) UNION (SELECT 2)');
  assert.equal(stmts[0]?.firstWord, 'SELECT');
  assert.equal(stmts[0]?.returnsRows, true);
});

test('returnsRows tells queries from commands', () => {
  assert.equal(returnsRows('SELECT 1'), true);
  assert.equal(returnsRows('VALUES (1), (2)'), true);
  assert.equal(returnsRows('TABLE t'), true);
  assert.equal(returnsRows('SHOW ALL'), true);
  assert.equal(returnsRows('EXPLAIN (ANALYZE) SELECT 1'), true);
  assert.equal(returnsRows('FETCH 100 FROM c'), true);
  assert.equal(returnsRows('MOVE 100 IN c'), false);
  assert.equal(returnsRows('CALL do_work(1)'), false);
  assert.equal(returnsRows('BEGIN'), false);
  assert.equal(returnsRows('CREATE TABLE t (a int)'), false);
});

test('returnsRows needs a top-level RETURNING for DML', () => {
  assert.equal(returnsRows('INSERT INTO t VALUES (1)'), false);
  assert.equal(returnsRows('INSERT INTO t VALUES (1) RETURNING id'), true);
  assert.equal(returnsRows('UPDATE t SET a = 1'), false);
  assert.equal(returnsRows('UPDATE t SET a = 1 RETURNING *'), true);
  assert.equal(returnsRows('DELETE FROM t WHERE a = 1 RETURNING a'), true);
  assert.equal(returnsRows('MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN DO NOTHING'), false);
  // the word only counts as a keyword, never as string or identifier text
  assert.equal(returnsRows("INSERT INTO t VALUES ('returning')"), false);
  assert.equal(returnsRows('INSERT INTO t ("returning") VALUES (1)'), false);
  assert.equal(returnsRows('INSERT INTO t SELECT * FROM (SELECT 1 AS returning) s'), false);
});

test('returnsRows follows the outer statement of a WITH', () => {
  assert.equal(returnsRows('WITH a AS (SELECT 1) SELECT * FROM a'), true);
  assert.equal(returnsRows('WITH a AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM a'), true);
  assert.equal(returnsRows('WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a'), false);
  assert.equal(returnsRows('WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a RETURNING id'), true);
  assert.equal(returnsRows('WITH RECURSIVE a AS (SELECT 1) TABLE a'), true);
});

test('simpleOnly flags what the extended protocol cannot run', () => {
  assert.equal(needsSimpleProtocol('VACUUM'), true);
  assert.equal(needsSimpleProtocol('VACUUM (ANALYZE) t'), true);
  assert.equal(needsSimpleProtocol('ANALYZE t'), true);
  assert.equal(needsSimpleProtocol('REINDEX INDEX i'), true);
  assert.equal(needsSimpleProtocol('CLUSTER t USING i'), true);
  assert.equal(needsSimpleProtocol('CHECKPOINT'), true);
  assert.equal(needsSimpleProtocol('DISCARD ALL'), true);
  assert.equal(needsSimpleProtocol('LISTEN chan'), true);
  assert.equal(needsSimpleProtocol('UNLISTEN chan'), true);
  assert.equal(needsSimpleProtocol("NOTIFY chan, 'x'"), true);
  assert.equal(needsSimpleProtocol('COPY t TO STDOUT'), true);
  assert.equal(needsSimpleProtocol('CREATE DATABASE d'), true);
  assert.equal(needsSimpleProtocol('DROP DATABASE IF EXISTS d'), true);
  assert.equal(needsSimpleProtocol("CREATE TABLESPACE ts LOCATION '/data/ts'"), true);
  assert.equal(needsSimpleProtocol("ALTER SYSTEM SET work_mem = '64MB'"), true);
});

test('simpleOnly flags CONCURRENTLY but not the plain form', () => {
  assert.equal(needsSimpleProtocol('CREATE INDEX CONCURRENTLY i ON t (a)'), true);
  assert.equal(needsSimpleProtocol('CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)'), true);
  assert.equal(needsSimpleProtocol('CREATE INDEX i ON t (a)'), false);
  assert.equal(needsSimpleProtocol('DROP INDEX CONCURRENTLY i'), true);
  assert.equal(needsSimpleProtocol('DROP INDEX i'), false);
  assert.equal(needsSimpleProtocol('REFRESH MATERIALIZED VIEW CONCURRENTLY mv'), true);
  assert.equal(needsSimpleProtocol('REFRESH MATERIALIZED VIEW mv'), false);
});

test('simpleOnly leaves ordinary statements alone', () => {
  assert.equal(needsSimpleProtocol('SET search_path = public'), false);
  assert.equal(needsSimpleProtocol('RESET ALL'), false);
  assert.equal(needsSimpleProtocol('SELECT 1'), false);
  assert.equal(needsSimpleProtocol('BEGIN'), false);
  assert.equal(needsSimpleProtocol('EXPLAIN ANALYZE SELECT 1'), false);
  assert.equal(needsSimpleProtocol("SELECT 'VACUUM'"), false);
});
