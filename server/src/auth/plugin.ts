import { createHmac, timingSafeEqual } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig, CurrentUser } from '@shared/protocol.js';
import { env } from '../env.js';
import { hashPassword, newId, verifyPassword } from '../crypto.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** set by the onRequest hook: undefined = not resolved yet, null = anonymous */
    user?: CurrentUser | null;
  }
}

const SESSION_COOKIE = 'sqlmypg_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const BAD_CREDENTIALS = 'Wrong email or password';

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/* --------------------------------- cookies -------------------------------- */
// Signed and read here with node:crypto rather than through reply.setCookie /
// req.unsignCookie, so these helpers keep working for route files registered in a
// different plugin scope than this one (fastify-plugin is not a dependency).

function hmac(payload: string): string {
  return createHmac('sha256', env.APP_SECRET).update(payload).digest('base64url');
}

function readRawCookie(req: FastifyRequest, name: string): string | undefined {
  const parsed = req.cookies?.[name];
  if (parsed !== undefined) return parsed;
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const split = part.indexOf('=');
    if (split > 0 && part.slice(0, split).trim() === name) return part.slice(split + 1).trim();
  }
  return undefined;
}

export function setSignedCookie(reply: FastifyReply, name: string, value: string, maxAgeSeconds: number): void {
  const payload = Buffer.from(value, 'utf8').toString('base64url');
  const attrs = [`${name}=${payload}.${hmac(payload)}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax'];
  if (env.COOKIE_SECURE) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}

export function clearCookie(reply: FastifyReply, name: string): void {
  const attrs = [`${name}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (env.COOKIE_SECURE) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}

/** null when the cookie is missing, malformed, or not signed by this secret. */
export function readSignedCookie(req: FastifyRequest, name: string): string | null {
  const raw = readRawCookie(req, name);
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const expected = Buffer.from(hmac(payload));
  const given = Buffer.from(raw.slice(dot + 1));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return Buffer.from(payload, 'base64url').toString('utf8');
}

/* --------------------------------- session -------------------------------- */

const sessionPayload = z.object({
  uid: z.string().min(1),
  email: z.string().min(1),
  name: z.string().nullable(),
  isAdmin: z.boolean(),
  provider: z.enum(['local', 'oidc']),
});

// ponytail: no server-side session store means no instant revocation - a deleted or demoted user
// keeps working until the cookie expires; the upgrade is a sessions table keyed by a token id that
// the onRequest hook looks up, deleted on logout and on any change to the user.
export function setSessionCookie(reply: FastifyReply, user: CurrentUser): void {
  const payload = { uid: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin, provider: user.provider };
  setSignedCookie(reply, SESSION_COOKIE, JSON.stringify(payload), SESSION_MAX_AGE);
}

export function clearSessionCookie(reply: FastifyReply): void {
  clearCookie(reply, SESSION_COOKIE);
}

function parseSession(req: FastifyRequest): CurrentUser | null {
  const json = readSignedCookie(req, SESSION_COOKIE);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = sessionPayload.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  return { id: s.uid, email: s.email, name: s.name, isAdmin: s.isAdmin, provider: s.provider };
}

export function currentUser(req: FastifyRequest): CurrentUser | null {
  if (req.user !== undefined) return req.user;
  req.user = parseSession(req); // the onRequest hook did not run in this scope
  return req.user;
}

export function requireUser(req: FastifyRequest): CurrentUser {
  const user = currentUser(req);
  if (!user) throw httpError(401, 'Not signed in');
  return user;
}

function requireAdmin(req: FastifyRequest): CurrentUser {
  const user = requireUser(req);
  if (!user.isAdmin) throw httpError(403, 'Admins only');
  return user;
}

/* ------------------------------ rate limiting ----------------------------- */

const attempts = new Map<string, { count: number; resetAt: number }>();

// ponytail: per-process counters, so N replicas allow N x 10 attempts a minute and a restart
// forgets every counter; the upgrade behind more than one replica is INCR + EXPIRE in Redis.
function rateLimit(req: FastifyRequest): void {
  const now = Date.now();
  for (const [ip, hit] of attempts) if (hit.resetAt <= now) attempts.delete(ip);
  const hit = attempts.get(req.ip);
  if (!hit) {
    attempts.set(req.ip, { count: 1, resetAt: now + 60_000 });
    return;
  }
  if (++hit.count > 10) throw httpError(429, 'Too many attempts, wait a minute');
}

/* -------------------------------- validation ------------------------------ */

const emailField = z.string().trim().toLowerCase().pipe(z.email());
const passwordField = z.string().min(10, 'password must be at least 10 characters');
const nameField = z.string().trim().max(200);

const loginBody = z.object({ email: emailField, password: z.string().min(1) });
const newUserBody = z.object({ email: emailField, password: passwordField, name: nameField.optional() });
const createUserBody = newUserBody.extend({ isAdmin: z.boolean().optional() });
const patchUserBody = z.object({
  password: passwordField.optional(),
  isAdmin: z.boolean().optional(),
  name: nameField.nullable().optional(),
});

function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data as z.infer<S>;
  throw httpError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
}

/* ----------------------------------- data --------------------------------- */

const userCols = {
  id: users.id,
  email: users.email,
  name: users.name,
  isAdmin: users.isAdmin,
  provider: users.provider,
};

export function toUser(row: {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean | null;
  provider: string | null;
}): CurrentUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: row.isAdmin === true,
    provider: row.provider === 'oidc' ? 'oidc' : 'local',
  };
}

async function anyUserExists(): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows.length > 0;
}

/** true when an admin other than `exceptId` exists - the last-admin guard. */
async function otherAdminExists(exceptId: string): Promise<boolean> {
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(2);
  return admins.some((a) => a.id !== exceptId);
}

async function findById(id: string) {
  const rows = await db.select(userCols).from(users).where(eq(users.id, id)).limit(1);
  return rows[0];
}

/* ---------------------------------- routes -------------------------------- */

export const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyCookie, { secret: env.APP_SECRET });

  fastify.addHook('onRequest', async (req, reply) => {
    req.user = parseSession(req);
    // tampered, forged or stale-secret cookie: anonymous, and drop the cookie
    if (req.user === null && readRawCookie(req, SESSION_COOKIE) !== undefined) clearSessionCookie(reply);
  });

  fastify.get('/api/auth/config', async (): Promise<AuthConfig> => ({
    needsBootstrap: !(await anyUserExists()),
    localEnabled: env.LOCAL_AUTH,
    oidcEnabled: env.oidcEnabled,
    oidcLabel: env.oidcEnabled ? env.OIDC_LABEL || null : null,
  }));

  fastify.get('/api/auth/me', async (req): Promise<CurrentUser> => requireUser(req));

  fastify.post('/api/auth/bootstrap', async (req, reply): Promise<CurrentUser> => {
    rateLimit(req);
    if (await anyUserExists()) throw httpError(409, 'Already set up');
    const body = parseBody(newUserBody, req.body);
    const passwordHash = await hashPassword(body.password);
    const user = await db.transaction(async (tx) => {
      // serialises racing first-run requests: the loser sees the row and 409s
      await tx.execute(sql`lock table ${users} in exclusive mode`);
      const taken = await tx.select({ id: users.id }).from(users).limit(1);
      if (taken.length > 0) throw httpError(409, 'Already set up');
      const rows = await tx
        .insert(users)
        .values({
          id: newId(),
          email: body.email,
          name: body.name ?? null,
          passwordHash,
          isAdmin: true,
          provider: 'local',
        })
        .returning(userCols);
      const row = rows[0];
      if (!row) throw httpError(500, 'Could not create the first user');
      return toUser(row);
    });
    setSessionCookie(reply, user);
    return user;
  });

  fastify.post('/api/auth/login', async (req, reply): Promise<CurrentUser> => {
    rateLimit(req);
    if (!env.LOCAL_AUTH) throw httpError(403, 'Password sign-in is disabled');
    const body = parseBody(loginBody, req.body);
    const rows = await db
      .select({ ...userCols, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    const row = rows[0];
    // unknown email and an OIDC-only account take the same path and cost as a wrong password
    if (!row?.passwordHash) {
      await hashPassword(body.password);
      throw httpError(401, BAD_CREDENTIALS);
    }
    if (!(await verifyPassword(body.password, row.passwordHash))) throw httpError(401, BAD_CREDENTIALS);
    const user = toUser(row);
    setSessionCookie(reply, user);
    return user;
  });

  fastify.post('/api/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  fastify.get('/api/auth/users', async (req): Promise<CurrentUser[]> => {
    requireAdmin(req);
    const rows = await db.select(userCols).from(users).orderBy(asc(users.email));
    return rows.map(toUser);
  });

  fastify.post('/api/auth/users', async (req): Promise<CurrentUser> => {
    requireAdmin(req);
    const body = parseBody(createUserBody, req.body);
    const passwordHash = await hashPassword(body.password);
    try {
      const rows = await db
        .insert(users)
        .values({
          id: newId(),
          email: body.email,
          name: body.name ?? null,
          passwordHash,
          isAdmin: body.isAdmin ?? false,
          provider: 'local',
        })
        .returning(userCols);
      const row = rows[0];
      if (!row) throw httpError(500, 'Could not create the user');
      return toUser(row);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw httpError(409, 'That email is already taken');
      throw err;
    }
  });

  fastify.patch<{ Params: { id: string } }>('/api/auth/users/:id', async (req): Promise<CurrentUser> => {
    requireAdmin(req);
    const body = parseBody(patchUserBody, req.body);
    const target = await findById(req.params.id);
    if (!target) throw httpError(404, 'No such user');
    const current = toUser(target);
    if (body.isAdmin === false && current.isAdmin && !(await otherAdminExists(current.id))) {
      throw httpError(409, 'That is the last admin');
    }
    const patch: { passwordHash?: string; isAdmin?: boolean; name?: string | null } = {};
    if (body.password !== undefined) patch.passwordHash = await hashPassword(body.password);
    if (body.isAdmin !== undefined) patch.isAdmin = body.isAdmin;
    if (body.name !== undefined) patch.name = body.name;
    if (Object.keys(patch).length === 0) return current;
    const rows = await db.update(users).set(patch).where(eq(users.id, current.id)).returning(userCols);
    const row = rows[0];
    if (!row) throw httpError(404, 'No such user');
    return toUser(row);
  });

  fastify.delete<{ Params: { id: string } }>('/api/auth/users/:id', async (req, reply) => {
    const me = requireAdmin(req);
    const target = await findById(req.params.id);
    if (!target) throw httpError(404, 'No such user');
    if (target.id === me.id) throw httpError(409, 'You cannot delete yourself');
    if (target.isAdmin === true && !(await otherAdminExists(target.id))) throw httpError(409, 'That is the last admin');
    await db.delete(users).where(eq(users.id, target.id));
    return reply.code(204).send();
  });
};
