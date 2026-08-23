import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ConnectionInfo } from '@shared/protocol.js';
import { requireUser } from '../auth/plugin.js';
import { encryptSecret, newId } from '../crypto.js';
import { db } from '../db/index.js';
import { connections, type ConnectionRow } from '../db/schema.js';
import { loadConnection, targetConfig, testConnection } from '../pg/pool.js';
import { closeSession, listSessions, toState } from '../session/manager.js';

const bad = (reply: FastifyReply, e: z.ZodError) =>
  reply.code(400).send({ error: 'ValidationError', issues: z.flattenError(e) });

const Params = z.object({ id: z.string().min(1) });

const Input = z.object({
  name: z.string().min(1).max(200),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(200),
  user: z.string().min(1).max(200),
  password: z.string().max(4096).optional(),
  sslMode: z.enum(['disable', 'prefer', 'require', 'verify-full']).optional(),
  color: z.string().max(32).nullish(),
  readOnly: z.boolean().optional(),
});
/** create requires the key; an empty string is legal (trust / peer auth) */
const NewInput = Input.extend({ password: z.string().max(4096) });

const toInfo = (r: ConnectionRow): ConnectionInfo => ({
  id: r.id,
  name: r.name,
  host: r.host,
  port: r.port,
  database: r.database,
  user: r.dbUser,
  sslMode: r.sslMode as ConnectionInfo['sslMode'],
  color: r.color,
  readOnly: r.readOnly,
  createdAt: r.createdAt.toISOString(),
});

// An unsaved form is tested through targetConfig too, so it gets byte-identical ssl handling.
// The encrypt-then-decrypt round trip is cheaper than a second copy of that logic.
const draftRow = (b: z.infer<typeof Input>): ConnectionRow => ({
  id: 'draft',
  ownerId: 'draft',
  name: b.name,
  host: b.host,
  port: b.port,
  database: b.database,
  dbUser: b.user,
  passwordEnc: b.password === undefined ? null : encryptSecret(b.password),
  sslMode: b.sslMode ?? 'prefer',
  color: b.color ?? null,
  readOnly: b.readOnly ?? false,
  createdAt: new Date(),
});

export const connectionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/connections', async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select()
      .from(connections)
      .where(eq(connections.ownerId, user.id))
      .orderBy(connections.name);
    return rows.map(toInfo);
  });

  app.post('/api/connections', async (req, reply) => {
    const user = requireUser(req);
    const p = NewInput.safeParse(req.body);
    if (!p.success) return bad(reply, p.error);
    const b = p.data;
    const [row] = await db
      .insert(connections)
      .values({
        id: newId(),
        ownerId: user.id,
        name: b.name,
        host: b.host,
        port: b.port,
        database: b.database,
        dbUser: b.user,
        passwordEnc: encryptSecret(b.password),
        sslMode: b.sslMode ?? 'prefer',
        color: b.color ?? null,
        readOnly: b.readOnly ?? false,
      })
      .returning();
    if (!row) return reply.code(500).send({ error: 'insert failed' });
    return reply.code(201).send(toInfo(row));
  });

  app.patch('/api/connections/:id', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = Input.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const [row] = await db
      .update(connections)
      .set({
        name: b.data.name,
        host: b.data.host,
        port: b.data.port,
        database: b.data.database,
        dbUser: b.data.user,
        sslMode: b.data.sslMode ?? 'prefer',
        color: b.data.color ?? null,
        readOnly: b.data.readOnly ?? false,
        ...(b.data.password === undefined ? {} : { passwordEnc: encryptSecret(b.data.password) }),
      })
      .where(and(eq(connections.id, p.data.id), eq(connections.ownerId, user.id)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'no such connection' });
    return toInfo(row);
  });

  app.delete('/api/connections/:id', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    // sessions pin a live backend on this connection: close them before the credentials vanish
    for (const s of listSessions(user.id).map(toState)) {
      if (s.connectionId === p.data.id) await closeSession(s.id, user.id);
    }
    const [row] = await db
      .delete(connections)
      .where(and(eq(connections.id, p.data.id), eq(connections.ownerId, user.id)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'no such connection' });
    return reply.code(204).send();
  });

  app.post('/api/connections/test', async (req, reply) => {
    requireUser(req);
    const p = Input.safeParse(req.body);
    if (!p.success) return bad(reply, p.error);
    return testConnection(targetConfig(draftRow(p.data)));
  });

  app.post('/api/connections/:id/test', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const row = await loadConnection(p.data.id, user.id);
    if (!row) return reply.code(404).send({ error: 'no such connection' });
    return testConnection(targetConfig(row));
  });
};
