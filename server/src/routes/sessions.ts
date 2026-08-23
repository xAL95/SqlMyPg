import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { execScript, fetchCursor, closeCursor } from '../session/exec.js';
import { cancelSession, closeSession, createSession, getSession, listSessions, toState } from '../session/manager.js';

const bad = (reply: FastifyReply, e: z.ZodError) =>
  reply.code(400).send({ error: 'ValidationError', issues: z.flattenError(e) });

const Params = z.object({ id: z.string().min(1) });
const CursorParams = Params.extend({ cursorId: z.string().min(1) });

const Create = z.object({
  connectionId: z.string().min(1),
  statementTimeoutMs: z.number().int().min(0).max(86_400_000).optional(),
});

const Exec = z.object({
  // not trimmed: statement offsets in the response must line up with the editor's text
  sql: z.string().min(1).max(5 * 1024 * 1024).refine((s) => s.trim() !== '', 'sql is empty'),
  maxRows: z.number().int().min(1).max(100_000).optional(),
});

const Fetch = z.object({ count: z.number().int().min(1).max(100_000).optional() });

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/sessions', async (req) => listSessions(requireUser(req).id).map(toState));

  app.post('/api/sessions', async (req, reply) => {
    const user = requireUser(req);
    const p = Create.safeParse(req.body);
    if (!p.success) return bad(reply, p.error);
    return reply.code(201).send(toState(await createSession(user.id, p.data)));
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const s = await getSession(p.data.id, user.id);
    if (!s) return reply.code(404).send({ error: 'no such session' });
    return toState(s);
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    await closeSession(p.data.id, user.id);
    return reply.code(204).send();
  });

  app.post('/api/sessions/:id/exec', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = Exec.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const s = await getSession(p.data.id, user.id);
    if (!s) return reply.code(404).send({ error: 'no such session' });
    return execScript(s, b.data);
  });

  app.post('/api/sessions/:id/cursor/:cursorId/fetch', async (req, reply) => {
    const user = requireUser(req);
    const p = CursorParams.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = Fetch.safeParse(req.body ?? {});
    if (!b.success) return bad(reply, b.error);
    const s = await getSession(p.data.id, user.id);
    if (!s) return reply.code(404).send({ error: 'no such session' });
    return fetchCursor(s, p.data.cursorId, b.data.count ?? 1000);
  });

  app.delete('/api/sessions/:id/cursor', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const s = await getSession(p.data.id, user.id);
    if (!s) return reply.code(404).send({ error: 'no such session' });
    await closeCursor(s);
    return reply.code(204).send();
  });

  app.post('/api/sessions/:id/cancel', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    return { cancelled: await cancelSession(p.data.id, user.id) };
  });
};
