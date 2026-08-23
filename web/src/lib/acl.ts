import { ident, literal } from '@/lib/ddl';

/**
 * Role and privilege statements, built as text.
 *
 * Same discipline as lib/ddl: pure, testable, every identifier quoted, and the statement is shown
 * before it runs. Postgres has no parameters in DDL, so a role name reaching SQL as an identifier
 * is the whole reason `ident` is not optional here.
 *
 * A password appears in the generated text because there is no other way to set one; the server
 * redacts it out of query history (see server/src/queryHistory.ts, redactSecrets).
 */

/** Cluster-wide role attributes, in the order Postgres prints them in \du. */
export type RoleAttrs = {
  login?: boolean;
  superuser?: boolean;
  createdb?: boolean;
  createrole?: boolean;
  inherit?: boolean;
  replication?: boolean;
  bypassrls?: boolean;
  /** -1 means no limit, which is Postgres's own default */
  connectionLimit?: number | null;
  /** an ISO timestamp, or null for no expiry */
  validUntil?: string | null;
  password?: string | null;
};

const FLAGS: [keyof RoleAttrs, string][] = [
  ['login', 'LOGIN'],
  ['superuser', 'SUPERUSER'],
  ['createdb', 'CREATEDB'],
  ['createrole', 'CREATEROLE'],
  ['inherit', 'INHERIT'],
  ['replication', 'REPLICATION'],
  ['bypassrls', 'BYPASSRLS'],
];

/** The attribute clauses for a CREATE or ALTER, in a stable order so a diff is readable. */
function attrClauses(a: RoleAttrs): string[] {
  const out: string[] = [];
  for (const [key, word] of FLAGS) {
    const v = a[key] as boolean | undefined;
    // Postgres negates by prefix, so a false flag is a NO-word rather than an omission.
    if (v !== undefined) out.push(v ? word : `NO${word}`);
  }
  if (a.connectionLimit !== undefined && a.connectionLimit !== null) {
    out.push(`CONNECTION LIMIT ${Math.trunc(a.connectionLimit)}`);
  }
  if (a.validUntil !== undefined) {
    out.push(a.validUntil === null ? "VALID UNTIL 'infinity'" : `VALID UNTIL ${literal(a.validUntil)}`);
  }
  if (a.password !== undefined) {
    out.push(a.password === null ? 'PASSWORD NULL' : `PASSWORD ${literal(a.password)}`);
  }
  return out;
}

export function createRole(name: string, attrs: RoleAttrs = {}): string {
  const clauses = attrClauses(attrs);
  return `CREATE ROLE ${ident(name)}${clauses.length ? ' WITH ' + clauses.join(' ') : ''};`;
}

/** An ALTER with nothing to change is not a statement; the caller gets null and shows nothing. */
export function alterRole(name: string, attrs: RoleAttrs): string | null {
  const clauses = attrClauses(attrs);
  if (clauses.length === 0) return null;
  return `ALTER ROLE ${ident(name)} WITH ${clauses.join(' ')};`;
}

export const renameRole = (from: string, to: string) => `ALTER ROLE ${ident(from)} RENAME TO ${ident(to)};`;

export const dropRole = (name: string) => `DROP ROLE ${ident(name)};`;

/* ------------------------------- membership ------------------------------- */

export const grantRole = (role: string, member: string, admin = false) =>
  `GRANT ${ident(role)} TO ${ident(member)}${admin ? ' WITH ADMIN OPTION' : ''};`;

export const revokeRole = (role: string, member: string, adminOptionOnly = false) =>
  `REVOKE ${adminOptionOnly ? 'ADMIN OPTION FOR ' : ''}${ident(role)} FROM ${ident(member)};`;

/* ------------------------------- privileges ------------------------------- */

export const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
export const SCHEMA_PRIVS = ['USAGE', 'CREATE'] as const;
export const DATABASE_PRIVS = ['CONNECT', 'CREATE', 'TEMPORARY'] as const;
export const SEQUENCE_PRIVS = ['USAGE', 'SELECT', 'UPDATE'] as const;

export type Target =
  | { kind: 'table'; schema: string; name: string }
  | { kind: 'allTables'; schema: string }
  | { kind: 'allSequences'; schema: string }
  | { kind: 'allFunctions'; schema: string }
  | { kind: 'sequence'; schema: string; name: string }
  | { kind: 'schema'; schema: string }
  | { kind: 'database'; name: string };

function targetSql(t: Target): string {
  switch (t.kind) {
    case 'table':
      return `TABLE ${ident(t.schema)}.${ident(t.name)}`;
    case 'sequence':
      return `SEQUENCE ${ident(t.schema)}.${ident(t.name)}`;
    case 'allTables':
      return `ALL TABLES IN SCHEMA ${ident(t.schema)}`;
    case 'allSequences':
      return `ALL SEQUENCES IN SCHEMA ${ident(t.schema)}`;
    case 'allFunctions':
      return `ALL FUNCTIONS IN SCHEMA ${ident(t.schema)}`;
    case 'schema':
      return `SCHEMA ${ident(t.schema)}`;
    case 'database':
      return `DATABASE ${ident(t.name)}`;
  }
}

/** PUBLIC is a keyword, not a role name, so it is the one grantee that must not be quoted. */
const grantee = (role: string) => (role.toUpperCase() === 'PUBLIC' ? 'PUBLIC' : ident(role));

export function grant(
  privs: readonly string[],
  target: Target,
  roles: readonly string[],
  opts: { withGrantOption?: boolean } = {},
): string {
  if (privs.length === 0 || roles.length === 0) throw new Error('grant needs a privilege and a role');
  const list = privs.length === TABLE_PRIVS.length && target.kind === 'table' ? 'ALL PRIVILEGES' : privs.join(', ');
  return (
    `GRANT ${list} ON ${targetSql(target)} TO ${roles.map(grantee).join(', ')}` +
    `${opts.withGrantOption ? ' WITH GRANT OPTION' : ''};`
  );
}

export function revoke(
  privs: readonly string[],
  target: Target,
  roles: readonly string[],
  opts: { grantOptionOnly?: boolean; cascade?: boolean } = {},
): string {
  if (privs.length === 0 || roles.length === 0) throw new Error('revoke needs a privilege and a role');
  const list = privs.length === TABLE_PRIVS.length && target.kind === 'table' ? 'ALL PRIVILEGES' : privs.join(', ');
  return (
    `REVOKE ${opts.grantOptionOnly ? 'GRANT OPTION FOR ' : ''}${list} ON ${targetSql(target)}` +
    ` FROM ${roles.map(grantee).join(', ')}${opts.cascade ? ' CASCADE' : ''};`
  );
}

/**
 * Default privileges apply to objects created LATER, and only to those created by the role named in
 * FOR ROLE. Granting on existing tables without this is the mistake that makes a grant look like it
 * silently stopped working the next time someone adds a table.
 */
export function alterDefaultPrivileges(
  forRole: string,
  schema: string | null,
  on: 'TABLES' | 'SEQUENCES' | 'FUNCTIONS' | 'TYPES' | 'SCHEMAS',
  privs: readonly string[],
  roles: readonly string[],
  action: 'grant' | 'revoke' = 'grant',
): string {
  const head = `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(forRole)}${schema ? ` IN SCHEMA ${ident(schema)}` : ''}`;
  const who = roles.map(grantee).join(', ');
  return action === 'grant'
    ? `${head} GRANT ${privs.join(', ')} ON ${on} TO ${who};`
    : `${head} REVOKE ${privs.join(', ')} ON ${on} FROM ${who};`;
}

export const alterOwner = (target: Target, role: string) => {
  const what = targetSql(target);
  return `ALTER ${what} OWNER TO ${ident(role)};`;
};

/**
 * Fold a pending set of statements into one transaction. A rights change that half-applies is
 * worse than one that fails, and the whole point of collecting them is to run them together.
 */
export function asTransaction(statements: readonly string[]): string {
  if (statements.length === 0) return '';
  if (statements.length === 1) return statements[0] as string;
  return ['BEGIN;', ...statements, 'COMMIT;'].join('\n');
}
