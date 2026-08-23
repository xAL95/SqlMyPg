/**
 * Roles and privileges on a TARGET database.
 *
 * The distinction this module exists to make visible: a privilege can be held *directly* (an entry
 * in the object's ACL) or held *effectively* (through role membership, or by owning the object).
 * Confusing the two is how "the role can connect, the tree lists the table, and reading it still
 * fails" happens - CONNECT is granted to PUBLIC by default and pg_catalog is world-readable, so a
 * role sees a table it has no privilege on. Both columns are reported so that is legible.
 */
import type { RelKind, RoleAttributes, RolePrivileges } from '@shared/protocol.js';
import { quoteIdent, quoteQualified } from './introspect.js';
import { withPooled, type TargetConfig } from './pool.js';

const httpError = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode });

/** Privileges Postgres defines per object class, in the order it prints them. */
export const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
export const SCHEMA_PRIVS = ['USAGE', 'CREATE'] as const;

/**
 * Every role on the cluster, with its attributes and direct memberships.
 *
 * `pg_*` roles are the server's own predefined roles; they are filtered out because nobody manages
 * them from a data browser, and they would triple the list.
 */
export async function listRoles(cfg: TargetConfig): Promise<RoleAttributes[]> {
  return withPooled(cfg, async (c) => {
    const res = await c.query<{
      name: string;
      canLogin: boolean;
      superuser: boolean;
      createdb: boolean;
      createrole: boolean;
      inherit: boolean;
      replication: boolean;
      bypassrls: boolean;
      connectionLimit: number;
      validUntil: string | null;
      hasPassword: boolean;
      memberOf: string[];
    }>(
      `SELECT r.rolname::text                             AS name,
              r.rolcanlogin                               AS "canLogin",
              r.rolsuper                                  AS superuser,
              r.rolcreatedb                               AS createdb,
              r.rolcreaterole                             AS createrole,
              r.rolinherit                                AS inherit,
              r.rolreplication                            AS replication,
              r.rolbypassrls                              AS bypassrls,
              r.rolconnlimit                              AS "connectionLimit",
              to_char(r.rolvaliduntil, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS "validUntil",
              -- never the hash itself, only whether one is set
              (r.rolpassword IS NOT NULL)                 AS "hasPassword",
              COALESCE(
                (SELECT array_agg(g.rolname::text ORDER BY g.rolname)
                   FROM pg_catalog.pg_auth_members m
                   JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
                  WHERE m.member = r.oid),
                '{}'::text[]
              )                                           AS "memberOf"
         FROM pg_catalog.pg_roles r
        WHERE r.rolname NOT LIKE 'pg\\_%'
        ORDER BY r.rolcanlogin DESC, r.rolname`,
    );
    return res.rows;
  });
}

/**
 * Who holds what on one relation.
 *
 * PUBLIC is a real grantee in Postgres (oid 0 in an ACL) but has no `pg_roles` row, so it is
 * unioned in by hand - leaving it out would hide the most common source of an unexpected grant.
 */
export async function relationPrivileges(
  cfg: TargetConfig,
  schema: string,
  name: string,
): Promise<{ schema: string; name: string; kind: RelKind; owner: string; roles: RolePrivileges[] }> {
  return withPooled(cfg, async (c) => {
    const rel = await c.query<{ oid: number; schema: string; name: string; relkind: string; owner: string }>(
      `SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
              pg_get_userbyid(c.relowner) AS owner
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','v','m','p','f')`,
      [schema, name],
    );
    const row = rel.rows[0];
    if (!row) throw httpError(404, `relation ${quoteQualified(schema, name)} does not exist`);

    const res = await c.query<{ role: string; direct: string[]; effective: string[]; isOwner: boolean }>(
      `WITH grantees AS (
         SELECT oid, rolname::text AS rolname FROM pg_catalog.pg_roles WHERE rolname NOT LIKE 'pg\\_%'
         UNION ALL SELECT 0::oid, 'PUBLIC'
       ),
       privs(p) AS (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')),
       direct AS (
         SELECT a.grantee, array_agg(a.privilege_type::text ORDER BY a.privilege_type) AS list
           FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.oid = $1
          GROUP BY a.grantee
       ),
       effective AS (
         SELECT g.oid AS grantee,
                COALESCE(
                  array_agg(privs.p ORDER BY privs.p)
                    FILTER (WHERE has_table_privilege(g.rolname, $1::oid, privs.p)),
                  '{}'::text[]
                ) AS list
           FROM grantees g CROSS JOIN privs
          WHERE g.oid <> 0
          GROUP BY g.oid, g.rolname
       )
       SELECT g.rolname                        AS role,
              COALESCE(d.list, '{}'::text[])           AS direct,
              CASE WHEN g.oid = 0 THEN COALESCE(d.list, '{}'::text[]) ELSE COALESCE(e.list, '{}'::text[]) END AS effective,
              (g.rolname = $2)                 AS "isOwner"
         FROM grantees g
         LEFT JOIN direct d    ON d.grantee = g.oid
         LEFT JOIN effective e ON e.grantee = g.oid
        -- a role with nothing at all on this object is noise in a matrix
        WHERE COALESCE(d.list, '{}'::text[]) <> '{}' OR COALESCE(e.list, '{}'::text[]) <> '{}' OR g.rolname = $2
        ORDER BY (g.rolname = $2) DESC, g.rolname`,
      [row.oid, row.owner],
    );

    const KIND: Record<string, RelKind> = { r: 'table', p: 'partitioned', v: 'view', m: 'matview', f: 'foreign' };
    return {
      schema: row.schema,
      name: row.name,
      kind: KIND[row.relkind] ?? 'table',
      owner: row.owner,
      roles: res.rows,
    };
  });
}

/** Who holds USAGE or CREATE on one schema - the privilege people forget before granting on tables. */
export async function schemaPrivileges(
  cfg: TargetConfig,
  schema: string,
): Promise<{ schema: string; owner: string; roles: RolePrivileges[] }> {
  return withPooled(cfg, async (c) => {
    const ns = await c.query<{ oid: number; owner: string }>(
      `SELECT oid, pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace WHERE nspname = $1`,
      [schema],
    );
    const row = ns.rows[0];
    if (!row) throw httpError(404, `schema ${quoteIdent(schema)} does not exist`);

    const res = await c.query<{ role: string; direct: string[]; effective: string[]; isOwner: boolean }>(
      `WITH grantees AS (
         SELECT oid, rolname::text AS rolname FROM pg_catalog.pg_roles WHERE rolname NOT LIKE 'pg\\_%'
         UNION ALL SELECT 0::oid, 'PUBLIC'
       ),
       privs(p) AS (VALUES ('USAGE'),('CREATE')),
       direct AS (
         SELECT a.grantee, array_agg(a.privilege_type::text ORDER BY a.privilege_type) AS list
           FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a
          WHERE n.oid = $1
          GROUP BY a.grantee
       ),
       effective AS (
         SELECT g.oid AS grantee,
                COALESCE(
                  array_agg(privs.p ORDER BY privs.p)
                    FILTER (WHERE has_schema_privilege(g.rolname, $2, privs.p)),
                  '{}'::text[]
                ) AS list
           FROM grantees g CROSS JOIN privs
          WHERE g.oid <> 0
          GROUP BY g.oid, g.rolname
       )
       SELECT g.rolname              AS role,
              COALESCE(d.list, '{}'::text[]) AS direct,
              CASE WHEN g.oid = 0 THEN COALESCE(d.list, '{}'::text[]) ELSE COALESCE(e.list, '{}'::text[]) END AS effective,
              (g.rolname = $3)       AS "isOwner"
         FROM grantees g
         LEFT JOIN direct d    ON d.grantee = g.oid
         LEFT JOIN effective e ON e.grantee = g.oid
        WHERE COALESCE(d.list, '{}'::text[]) <> '{}' OR COALESCE(e.list, '{}'::text[]) <> '{}' OR g.rolname = $3
        ORDER BY (g.rolname = $3) DESC, g.rolname`,
      [row.oid, schema, row.owner],
    );
    return { schema, owner: row.owner, roles: res.rows };
  });
}

/**
 * Apply one privilege change directly.
 *
 * No SQL text crosses the wire: the client posts an action, a privilege list, a target and a role
 * list, and the statement is assembled here from names checked against the catalog. Same invariant
 * as the grid's writes - an identifier in the emitted SQL came from pg_catalog, never from the
 * request body. Bulk changes do not use this path at all; those are generated into a query tab so
 * the user reads the whole script before any of it runs.
 */
export async function applyAclChange(
  cfg: TargetConfig,
  req: { action: 'grant' | 'revoke'; privileges: string[]; schema: string; name?: string; roles: string[]; cascade?: boolean },
): Promise<{ rowCount: number; sql: string; params: (string | null)[] }> {
  const onRelation = req.name !== undefined;
  const allowed: readonly string[] = onRelation ? TABLE_PRIVS : SCHEMA_PRIVS;
  const privs = req.privileges.map((p) => p.toUpperCase());
  if (privs.length === 0) throw httpError(400, 'no privilege given');
  for (const p of privs) {
    if (!allowed.includes(p)) {
      throw httpError(400, `${JSON.stringify(p)} is not a privilege on ${onRelation ? 'a table' : 'a schema'}`);
    }
  }
  if (req.roles.length === 0) throw httpError(400, 'no role given');

  return withPooled(cfg, async (c) => {
    // Resolve the target through the catalog so its quoted name comes from Postgres, not the body.
    let target: string;
    if (onRelation) {
      const r = await c.query<{ schema: string; name: string }>(
        `SELECT n.nspname AS schema, c.relname AS name
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','v','m','p','f')`,
        [req.schema, req.name],
      );
      const row = r.rows[0];
      if (!row) throw httpError(404, `relation ${quoteQualified(req.schema, String(req.name))} does not exist`);
      target = `TABLE ${quoteQualified(row.schema, row.name)}`;
    } else {
      const r = await c.query<{ nspname: string }>(
        `SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = $1`,
        [req.schema],
      );
      const row = r.rows[0];
      if (!row) throw httpError(404, `schema ${quoteIdent(req.schema)} does not exist`);
      target = `SCHEMA ${quoteIdent(row.nspname)}`;
    }

    // PUBLIC is a keyword rather than a role, so it is the one grantee that is not looked up.
    const grantees: string[] = [];
    for (const role of req.roles) {
      if (role.toUpperCase() === 'PUBLIC') {
        grantees.push('PUBLIC');
        continue;
      }
      const r = await c.query<{ rolname: string }>(
        `SELECT rolname::text AS rolname FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [role],
      );
      const row = r.rows[0];
      if (!row) throw httpError(404, `role ${JSON.stringify(role)} does not exist`);
      grantees.push(quoteIdent(row.rolname));
    }

    const list = privs.join(', ');
    const sql =
      req.action === 'grant'
        ? `GRANT ${list} ON ${target} TO ${grantees.join(', ')}`
        : `REVOKE ${list} ON ${target} FROM ${grantees.join(', ')}${req.cascade ? ' CASCADE' : ''}`;

    await c.query(sql);
    return { rowCount: 0, sql, params: [] };
  });
}
