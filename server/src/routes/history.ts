import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { HistoryEntry, SavedQuery } from '@shared/protocol.js';
import { requireUser } from '../auth/plugin.js';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { queryHistory, savedQueries, type SavedQueryRow } from '../db/schema.js';

const bad = (reply: FastifyReply, e: z.ZodError) =>
  reply.code(400).send({ error: 'ValidationError', issues: z.flattenError(e) });

const Params = z.object({ id: z.string().min(1) });

const HistoryQ = z.object({
  connectionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const SaveBody = z.object({
  name: z.string().min(1).max(200),
  sql: z.string().min(1).max(1024 * 1024),
  connectionId: z.string().min(1).nullish(),
});
const PatchBody = SaveBody.partial();

const toSaved = (r: SavedQueryRow): SavedQuery => ({
  id: r.id,
  name: r.name,
  sql: r.sql,
  connectionId: r.connectionId,
  updatedAt: r.updatedAt.toISOString(),
});

export const historyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/history', async (req, reply) => {
    const user = requireUser(req);
    const q = HistoryQ.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    const rows = await db
      .select()
      .from(queryHistory)
      .where(
        and(
          eq(queryHistory.userId, user.id),
          q.data.connectionId ? eq(queryHistory.connectionId, q.data.connectionId) : undefined,
        ),
      )
      .orderBy(desc(queryHistory.ranAt))
      .limit(q.data.limit);
    return rows.map(
      (r): HistoryEntry => ({
        id: r.id,
        connectionId: r.connectionId ?? '',
        connectionName: r.connectionName,
        sql: r.sql,
        durationMs: r.durationMs,
        rowCount: r.rowCount,
        error: r.error,
        ranAt: r.ranAt.toISOString(),
      }),
    );
  });

  app.delete('/api/history', async (req, reply) => {
    const user = requireUser(req);
    const q = HistoryQ.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    // the client clears one connection's history with ?connectionId=; without the filter that
    // request would wipe every connection's
    await db
      .delete(queryHistory)
      .where(
        and(
          eq(queryHistory.userId, user.id),
          q.data.connectionId ? eq(queryHistory.connectionId, q.data.connectionId) : undefined,
        ),
      );
    return reply.code(204).send();
  });

  app.get('/api/saved', async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select()
      .from(savedQueries)
      .where(eq(savedQueries.ownerId, user.id))
      .orderBy(savedQueries.name);
    return rows.map(toSaved);
  });

  app.post('/api/saved', async (req, reply) => {
    const user = requireUser(req);
    const b = SaveBody.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const [row] = await db
      .insert(savedQueries)
      .values({
        id: newId(),
        ownerId: user.id,
        name: b.data.name,
        sql: b.data.sql,
        connectionId: b.data.connectionId ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [savedQueries.ownerId, savedQueries.name],
        set: { sql: b.data.sql, connectionId: b.data.connectionId ?? null, updatedAt: new Date() },
      })
      .returning();
    if (!row) return reply.code(500).send({ error: 'upsert failed' });
    return toSaved(row);
  });

  app.patch('/api/saved/:id', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = PatchBody.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const [row] = await db
      .update(savedQueries)
      .set({
        ...(b.data.name === undefined ? {} : { name: b.data.name }),
        ...(b.data.sql === undefined ? {} : { sql: b.data.sql }),
        ...(b.data.connectionId === undefined ? {} : { connectionId: b.data.connectionId ?? null }),
        updatedAt: new Date(),
      })
      .where(and(eq(savedQueries.id, p.data.id), eq(savedQueries.ownerId, user.id)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'no such saved query' });
    return toSaved(row);
  });

  app.delete('/api/saved/:id', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    await db
      .delete(savedQueries)
      .where(and(eq(savedQueries.id, p.data.id), eq(savedQueries.ownerId, user.id)));
    return reply.code(204).send();
  });
};
