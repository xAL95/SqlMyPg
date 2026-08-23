import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alterDefaultPrivileges,
  alterOwner,
  alterRole,
  asTransaction,
  createRole,
  dropRole,
  grant,
  grantRole,
  renameRole,
  revoke,
  revokeRole,
  TABLE_PRIVS,
} from './acl.js';

test('a role name reaches SQL as a quoted identifier, always', () => {
  assert.equal(createRole('app'), 'CREATE ROLE "app";');
  assert.equal(createRole('MixedCase'), 'CREATE ROLE "MixedCase";');
  // the one place a role name could otherwise become SQL
  assert.equal(createRole('x"; DROP ROLE y; --'), 'CREATE ROLE "x""; DROP ROLE y; --";');
});

test('attributes are emitted with Postgres negation, not omission', () => {
  assert.equal(
    createRole('app', { login: true, createdb: false, inherit: true }),
    'CREATE ROLE "app" WITH LOGIN NOCREATEDB INHERIT;',
  );
  // a flag left undefined is not mentioned at all, so an ALTER touches nothing else
  assert.equal(alterRole('app', { superuser: false }), 'ALTER ROLE "app" WITH NOSUPERUSER;');
  assert.equal(alterRole('app', {}), null, 'an ALTER with nothing to change is not a statement');
});

test('password, connection limit and expiry', () => {
  assert.equal(createRole('a', { password: "O'Brien" }), `CREATE ROLE "a" WITH PASSWORD 'O''Brien';`);
  assert.equal(alterRole('a', { password: null }), 'ALTER ROLE "a" WITH PASSWORD NULL;');
  assert.equal(alterRole('a', { connectionLimit: 5 }), 'ALTER ROLE "a" WITH CONNECTION LIMIT 5;');
  assert.equal(alterRole('a', { validUntil: null }), `ALTER ROLE "a" WITH VALID UNTIL 'infinity';`);
  assert.equal(
    alterRole('a', { validUntil: '2027-01-01T00:00:00Z' }),
    `ALTER ROLE "a" WITH VALID UNTIL '2027-01-01T00:00:00Z';`,
  );
});

test('membership, including the admin option on its own', () => {
  assert.equal(grantRole('animeshow', 'sqlmypg'), 'GRANT "animeshow" TO "sqlmypg";');
  assert.equal(grantRole('a', 'b', true), 'GRANT "a" TO "b" WITH ADMIN OPTION;');
  assert.equal(revokeRole('a', 'b'), 'REVOKE "a" FROM "b";');
  assert.equal(revokeRole('a', 'b', true), 'REVOKE ADMIN OPTION FOR "a" FROM "b";');
  assert.equal(renameRole('a', 'b'), 'ALTER ROLE "a" RENAME TO "b";');
  assert.equal(dropRole('a'), 'DROP ROLE "a";');
});

test('privileges on a table, schema and database', () => {
  assert.equal(
    grant(['SELECT'], { kind: 'table', schema: 'shop', name: 'events' }, ['sqlmypg']),
    'GRANT SELECT ON TABLE "shop"."events" TO "sqlmypg";',
  );
  assert.equal(
    grant(['USAGE'], { kind: 'schema', schema: 'shop' }, ['a', 'b']),
    'GRANT USAGE ON SCHEMA "shop" TO "a", "b";',
  );
  assert.equal(
    grant(['CONNECT'], { kind: 'database', name: 'animeshow' }, ['sqlmypg']),
    'GRANT CONNECT ON DATABASE "animeshow" TO "sqlmypg";',
  );
  assert.equal(
    grant(['SELECT'], { kind: 'allTables', schema: 'public' }, ['sqlmypg']),
    'GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "sqlmypg";',
  );
});

test('the full table set collapses to ALL PRIVILEGES', () => {
  assert.equal(
    grant([...TABLE_PRIVS], { kind: 'table', schema: 's', name: 't' }, ['r']),
    'GRANT ALL PRIVILEGES ON TABLE "s"."t" TO "r";',
  );
  // one short of the set stays explicit, so the statement says exactly what it does
  assert.match(grant(['SELECT', 'INSERT'], { kind: 'table', schema: 's', name: 't' }, ['r']), /GRANT SELECT, INSERT /);
});

test('PUBLIC is a keyword and must not be quoted', () => {
  assert.equal(
    grant(['SELECT'], { kind: 'table', schema: 's', name: 't' }, ['PUBLIC']),
    'GRANT SELECT ON TABLE "s"."t" TO PUBLIC;',
  );
  // and it is recognised whatever case the caller used
  assert.match(revoke(['CONNECT'], { kind: 'database', name: 'd' }, ['public']), /FROM PUBLIC;$/);
});

test('revoke carries cascade and the grant-option-only form', () => {
  assert.equal(
    revoke(['SELECT'], { kind: 'table', schema: 's', name: 't' }, ['r'], { cascade: true }),
    'REVOKE SELECT ON TABLE "s"."t" FROM "r" CASCADE;',
  );
  assert.match(
    revoke(['SELECT'], { kind: 'table', schema: 's', name: 't' }, ['r'], { grantOptionOnly: true }),
    /^REVOKE GRANT OPTION FOR SELECT /,
  );
  assert.match(
    grant(['SELECT'], { kind: 'table', schema: 's', name: 't' }, ['r'], { withGrantOption: true }),
    / WITH GRANT OPTION;$/,
  );
});

test('an empty privilege or role list is refused rather than emitting broken SQL', () => {
  assert.throws(() => grant([], { kind: 'schema', schema: 's' }, ['r']), /needs a privilege and a role/);
  assert.throws(() => revoke(['SELECT'], { kind: 'schema', schema: 's' }, []), /needs a privilege and a role/);
});

test('default privileges name the creating role, which is the part people miss', () => {
  assert.equal(
    alterDefaultPrivileges('animeshow', 'public', 'TABLES', ['SELECT'], ['sqlmypg']),
    'ALTER DEFAULT PRIVILEGES FOR ROLE "animeshow" IN SCHEMA "public" GRANT SELECT ON TABLES TO "sqlmypg";',
  );
  assert.match(
    alterDefaultPrivileges('a', null, 'SEQUENCES', ['USAGE'], ['b'], 'revoke'),
    /^ALTER DEFAULT PRIVILEGES FOR ROLE "a" REVOKE USAGE ON SEQUENCES FROM "b";$/,
  );
});

test('ownership', () => {
  assert.equal(alterOwner({ kind: 'table', schema: 's', name: 't' }, 'r'), 'ALTER TABLE "s"."t" OWNER TO "r";');
  assert.equal(alterOwner({ kind: 'schema', schema: 's' }, 'r'), 'ALTER SCHEMA "s" OWNER TO "r";');
});

test('a batch runs as one transaction, a single statement does not need one', () => {
  assert.equal(asTransaction([]), '');
  assert.equal(asTransaction(['GRANT a ON b TO c;']), 'GRANT a ON b TO c;');
  assert.equal(
    asTransaction(['GRANT x;', 'REVOKE y;']),
    'BEGIN;\nGRANT x;\nREVOKE y;\nCOMMIT;',
    'a rights change that half-applies is worse than one that fails',
  );
});
