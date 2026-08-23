import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { browse, deleteRows, insertRow, resolveByOids, updateCell } from '../pg/browse.js';
import { dropTable, truncateTable } from '../pg/ddl.js';
import { applyAclChange, listRoles, relationPrivileges, schemaPrivileges } from '../pg/roles.js';
import {
  completionSnapshot,
  explainPlan,
  listRelations,
  listRoutines,
  listSchemas,
  relationDetail,
  serverInfo,
} from '../pg/introspect.js';
import { loadConnection, targetConfig, type TargetConfig } from '../pg/pool.js';
import { inlineParams, recordQuery } from '../queryHistory.js';

const bad = (reply: FastifyReply, e: z.ZodError) =>
  reply.code(400).send({ error: 'ValidationError', issues: z.flattenError(e) });

const Params = z.object({ id: z.string().min(1) });
const SchemaQ = z.object({ schema: z.string().min(1).max(200).default('public') });
const RelationQ = SchemaQ.extend({ name: z.string().min(1).max(200) });

const Browse = z.object({
  schema: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(10_000).optional(),
  orderBy: z.array(z.object({ column: z.string().min(1).max(200), desc: z.boolean() })).max(16).optional(),
  after: z.array(z.string().nullable()).max(16).optional(),
  where: z.string().max(100_000).optional(),
});

const InsertRow = z.object({
  schema: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  /** column -> value; omitted columns fall back to their default, identity or NULL */
  values: z.record(z.string().min(1).max(200), z.string().max(1024 * 1024).nullable()),
});

const DeleteRows = z.object({
  schema: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  /** one entry per row, each holding exactly the relation's unique-key columns */
  keys: z
    .array(z.record(z.string().min(1).max(200), z.string().max(1024 * 1024).nullable()))
    .min(1)
    .max(1000),
});

const ByOid = z.object({ oids: z.array(z.number().int().positive()).max(64) });

const UpdateCell = z.object({
  schema: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  /** exactly the relation's unique-key columns, holding the values the row was read with */
  key: z.record(z.string().min(1).max(200), z.string().max(1024 * 1024).nullable()),
  column: z.string().min(1).max(200),
  value: z.string().max(1024 * 1024).nullable(),
});

const Relation = z.object({
  schema: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  cascade: z.boolean().optional(),
});
const Truncate = Relation.extend({ restartIdentity: z.boolean().optional() });

const AclQuery = z.object({
  schema: z.string().min(1).max(200),
  /** omitted asks about the schema itself rather than a relation in it */
  name: z.string().min(1).max(200).optional(),
});

const AclChange = AclQuery.extend({
  action: z.enum(['grant', 'revoke']),
  privileges: z.array(z.string().min(1).max(40)).min(1).max(16),
  roles: z.array(z.string().min(1).max(200)).min(1).max(64),
  cascade: z.boolean().optional(),
});

const Explain = z.object({
  sql: z.string().min(1).max(1024 * 1024),
  analyze: z.boolean().optional(),
  buffers: z.boolean().optional(),
});

type Write = { rowCount: number; sql: string; params: (string | null)[] };

/**
 * Run one of the grid's writes and log it to query history, then hand back everything except the
 * statement plumbing. History gets the parameters substituted in so the entry reads like
 * something you could run again; the statement Postgres executed kept its placeholders.
 */
async function logged<T extends Write>(
  user: { id: string },
  row: { id: string; name: string },
  run: () => Promise<T>,
): Promise<Omit<T, 'sql' | 'params'>> {
  const started = performance.now();
  try {
    const res = await run();
    const { sql, params, ...rest } = res;
    if (sql) {
      recordQuery({
        userId: user.id,
        connectionId: row.id,
        connectionName: row.name,
        sql: inlineParams(sql, params),
        durationMs: performance.now() - started,
        rowCount: res.rowCount,
        error: null,
      });
    }
    return rest;
  } catch (err) {
    const tagged = err as { sqlText?: string; sqlParams?: (string | null)[] };
    // A rejected write is the more interesting history entry, not the less: it is how a failed
    // edit gets explained later. The generated SQL is only known when the failure came from
    // Postgres, so a validation error is logged by its message alone.
    recordQuery({
      userId: user.id,
      connectionId: row.id,
      connectionName: row.name,
      sql: tagged.sqlText === undefined
        ? '(rejected before reaching Postgres)'
        : inlineParams(tagged.sqlText, tagged.sqlParams ?? []),
      durationMs: performance.now() - started,
      rowCount: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Browsing always runs on a pooled connection so it can never block the user's pinned transaction. */
async function target(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<TargetConfig | null> {
  const p = Params.safeParse(req.params);
  if (!p.success) {
    bad(reply, p.error);
    return null;
  }
  const row = await loadConnection(p.data.id, userId);
  if (!row) {
    reply.code(404).send({ error: 'no such connection' });
    return null;
  }
  return targetConfig(row);
}

export const introspectRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/connections/:id/schemas', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    return listSchemas(cfg);
  });

  app.get('/api/connections/:id/relations', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    const q = SchemaQ.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    return listRelations(cfg, q.data.schema);
  });

  app.get('/api/connections/:id/relation', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    const q = RelationQ.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    return relationDetail(cfg, q.data.schema, q.data.name);
  });

  app.get('/api/connections/:id/routines', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    const q = SchemaQ.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    return listRoutines(cfg, q.data.schema);
  });

  app.get('/api/connections/:id/completion', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    return completionSnapshot(cfg);
  });

  app.get('/api/connections/:id/info', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    return serverInfo(cfg);
  });

  app.post('/api/connections/:id/browse', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    const b = Browse.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    return browse(cfg, b.data);
  });

  // Browsing goes through a pooled connection, which - unlike a query session - never gets
  // SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY, so a read-only connection has to be
  // refused here explicitly or the flag would be a UI decoration on this path.
  app.post('/api/connections/:id/rows', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = InsertRow.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const row = await loadConnection(p.data.id, user.id);
    if (row.readOnly) return reply.code(403).send({ error: 'this connection is read-only' });
    return logged(user, row, () => insertRow(targetConfig(row), b.data));
  });

  app.delete('/api/connections/:id/rows', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = DeleteRows.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const row = await loadConnection(p.data.id, user.id);
    if (row.readOnly) return reply.code(403).send({ error: 'this connection is read-only' });
    return logged(user, row, () => deleteRows(targetConfig(row), b.data));
  });

  // A query result names its source tables only by oid. Resolving them is what lets the results
  // grid offer an edit on a column that came from a real table; the PATCH below still re-derives
  // the relation and its key from the catalog, so this lookup grants nothing on its own.
  app.post('/api/connections/:id/relations/by-oid', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    const b = ByOid.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    return resolveByOids(cfg, b.data.oids);
  });

  app.patch('/api/connections/:id/rows', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = UpdateCell.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const row = await loadConnection(p.data.id, user.id);
    if (row.readOnly) return reply.code(403).send({ error: 'this connection is read-only' });
    return logged(user, row, () => updateCell(targetConfig(row), b.data));
  });

  // CREATE TABLE and the ALTER family are generated in the browser and run through a query tab,
  // so they are reviewable and land in a transaction the user controls. Only these two act on
  // their own, behind a confirm dialog.
  app.post('/api/connections/:id/truncate', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = Truncate.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const row = await loadConnection(p.data.id, user.id);
    if (row.readOnly) return reply.code(403).send({ error: 'this connection is read-only' });
    return logged(user, row, () => truncateTable(targetConfig(row), b.data));
  });

  app.post('/api/connections/:id/drop', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = Relation.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const row = await loadConnection(p.data.id, user.id);
    if (row.readOnly) return reply.code(403).send({ error: 'this connection is read-only' });
    return logged(user, row, () => dropTable(targetConfig(row), b.data));
  });

  app.get('/api/connections/:id/roles', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    return listRoles(cfg);
  });

  app.get('/api/connections/:id/privileges', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    const q = AclQuery.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    return q.data.name === undefined
      ? schemaPrivileges(cfg, q.data.schema)
      : relationPrivileges(cfg, q.data.schema, q.data.name);
  });

  // One toggle acts now. A change across many objects is generated into a query tab instead, so
  // nobody rewrites a cluster's permissions through a stream of single requests.
  app.post('/api/connections/:id/privileges', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = AclChange.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const row = await loadConnection(p.data.id, user.id);
    if (row.readOnly) return reply.code(403).send({ error: 'this connection is read-only' });
    return logged(user, row, () => applyAclChange(targetConfig(row), b.data));
  });

  app.post('/api/connections/:id/explain', async (req, reply) => {
    const cfg = await target(req, reply, requireUser(req).id);
    if (!cfg) return reply;
    const b = Explain.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    return explainPlan(cfg, b.data.sql, { analyze: b.data.analyze ?? false, buffers: b.data.buffers ?? false });
  });
};
