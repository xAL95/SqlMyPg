/**
 * SqlMyPg entry point.
 *
 * env is imported before anything else on purpose: it validates process.env at module
 * evaluation and exits on a bad configuration, so nothing binds a socket or opens a pool
 * behind a broken config.
 */
import { env, version } from './env.js';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { LogController } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { oidcRoutes } from './auth/oidc.js';
import { authPlugin } from './auth/plugin.js';
import { closeDb } from './db/index.js';
import { ensureSchema } from './db/migrate.js';
import { closeAllPools } from './pg/pool.js';
import { INSUFFICIENT_PRIVILEGE, pgSqlstate } from './pg/sqlstate.js';
import { connectionRoutes } from './routes/connections.js';
import { exportCsvRoutes } from './routes/exportCsv.js';
import { historyRoutes } from './routes/history.js';
import { introspectRoutes } from './routes/introspect.js';
import { sessionRoutes } from './routes/sessions.js';
import { closeAllSessions, startReaper } from './session/manager.js';
import { wsRoutes } from './ws.js';

const dev = env.NODE_ENV === 'development';

const app = Fastify({
  // fastify merges its own standard req/res/err serializers into whatever is passed here, so
  // the level is the only knob worth setting - a pretty transport would be another dependency.
  logger: { level: dev ? 'debug' : 'info' },
  // the docker HEALTHCHECK polls /api/health every few seconds; two log lines each is noise
  logController: new LogController({ disableRequestLogging: (req) => req.url.startsWith('/api/health') }),
  trustProxy: env.TRUST_PROXY,
  bodyLimit: 2 * 1024 * 1024, // POST /api/sessions/:id/exec raises this for big scripts
});

/**
 * Every route layer throws `Object.assign(new Error(msg), { statusCode })`, so that is the
 * contract here. A stack trace never leaves the process: 5xx bodies are generic and the real
 * error goes to the log.
 */
app.setErrorHandler((err, req, reply) => {
  if (reply.sent || reply.raw.headersSent) return; // the CSV export hijacks and streams its own reply
  const zod = err instanceof ZodError ? err : null;
  const real = err instanceof Error ? err : new Error(String(err));
  const given = (err as { statusCode?: unknown }).statusCode;
  // A Postgres error is about the user's SQL or their grants on the target database, not a fault
  // in this process: hiding "permission denied for table x" behind a generic 500 leaves the user
  // with nothing to act on.
  const pg = pgSqlstate(err);
  const status = zod
    ? 400
    : typeof given === 'number' && given >= 400 && given <= 599
      ? given
      : pg === undefined
        ? 500
        : pg === INSUFFICIENT_PRIVILEGE
          ? 403
          : 400;

  if (status >= 500) {
    req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: 'InternalServerError', message: 'Internal server error' });
  }
  return reply.code(status).send({
    error: zod ? 'ValidationError' : real.name || 'Error',
    message: zod
      ? zod.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
      : real.message,
  });
});

// no auth: this is what the container healthcheck and any load balancer polls
app.get('/api/health', async () => ({ ok: true, version, uptime: Math.round(process.uptime()) }));

// dev only: vite serves the app from :5273 and proxies /api, so this is just the escape hatch
// for running the web dev server against a differently-hosted API.
if (dev) await app.register(fastifyCors, { origin: 'http://localhost:5273', credentials: true });

await app.register(authPlugin);
await app.register(fastifyWebsocket);
await app.register(wsRoutes);

await app.register(oidcRoutes);
await app.register(connectionRoutes);
await app.register(sessionRoutes);
await app.register(introspectRoutes);
await app.register(exportCsvRoutes);
await app.register(historyRoutes);

if (env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: env.WEB_DIST, index: ['index.html'] });
  // The shell is read once: the process is the deploy unit, so a new build is a new process.
  const indexHtml = await readFile(join(env.WEB_DIST, 'index.html'), 'utf8');
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'NotFound', message: `${req.method} ${req.url} not found` });
    }
    // a client-side route: hand back the shell, uncached - a cached index.html outlives the
    // hashed asset names it points at
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(indexHtml);
  });
}

await ensureSchema((m) => app.log.info(m));

const address = await app.listen({ host: env.HOST, port: env.PORT });
startReaper();
app.log.info(
  `SqlMyPg ${version} on ${address} - oidc ${env.oidcEnabled ? 'enabled' : 'disabled'}, ` +
    `local auth ${env.LOCAL_AUTH ? 'enabled' : 'disabled'}`,
);

let stopping = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) {
    app.log.warn(`${signal} again, exiting now`);
    process.exit(1);
  }
  stopping = true;
  app.log.info(`${signal}, shutting down`);
  // a query still running on a pinned backend must not hold the process hostage
  const bail = setTimeout(() => {
    app.log.error('shutdown timed out, exiting');
    process.exit(1);
  }, 10_000);
  try {
    await app.close(); // stops accepting connections and runs the onClose hooks (websocket teardown)
    await closeAllSessions(`server ${signal}`);
    await closeAllPools();
    await closeDb();
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
  }
  clearTimeout(bail);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
