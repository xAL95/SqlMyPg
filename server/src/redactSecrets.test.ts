import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets } from './queryHistory.js';

test('a role password never reaches history', () => {
  assert.equal(
    redactSecrets("CREATE ROLE app LOGIN PASSWORD 'sup3r secret';"),
    "CREATE ROLE app LOGIN PASSWORD '<redacted>';",
  );
  assert.equal(
    redactSecrets("ALTER ROLE app ENCRYPTED PASSWORD 'hunter2'"),
    "ALTER ROLE app ENCRYPTED PASSWORD '<redacted>'",
  );
  // a foreign-server user mapping carries its secret the same way
  assert.equal(
    redactSecrets("CREATE USER MAPPING FOR app SERVER s OPTIONS (user 'u', password 'p')"),
    "CREATE USER MAPPING FOR app SERVER s OPTIONS (user 'u', password '<redacted>')",
  );
});

test('a literal containing a doubled quote is consumed whole', () => {
  assert.equal(redactSecrets("PASSWORD 'a''b' , x"), "PASSWORD '<redacted>' , x");
});

test('every occurrence is redacted, not just the first', () => {
  assert.equal(
    redactSecrets("CREATE ROLE a PASSWORD 'x'; CREATE ROLE b PASSWORD 'y';"),
    "CREATE ROLE a PASSWORD '<redacted>'; CREATE ROLE b PASSWORD '<redacted>';",
  );
});

test('what must NOT be touched', () => {
  // no secret to hide
  assert.equal(redactSecrets('ALTER ROLE app PASSWORD NULL'), 'ALTER ROLE app PASSWORD NULL');
  // a different keyword that merely starts with the word
  assert.equal(
    redactSecrets("SET password_encryption = 'scram-sha-256'"),
    "SET password_encryption = 'scram-sha-256'",
  );
  // your own data: a predicate over a column named password keeps its value, or history lies
  assert.equal(
    redactSecrets("SELECT * FROM users WHERE password = 'abc'"),
    "SELECT * FROM users WHERE password = 'abc'",
  );
  // ordinary SQL is returned byte for byte
  const plain = 'SELECT id, note FROM shop.events ORDER BY id LIMIT 200;';
  assert.equal(redactSecrets(plain), plain);
});
