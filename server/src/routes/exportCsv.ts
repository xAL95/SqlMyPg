import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { to } from 'pg-copy-streams';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { loadConnection, poolFor, targetConfig } from '../pg/pool.js';
import { splitStatements } from '../pg/sqlSplit.js';
import { tableSelect } from '../pg/browse.js';

const Params = z.object({ id: z.string().min(1) });
const Body = z.object({
  sql: z.string().min(1).max(5 * 1024 * 1024).optional(),
  schema: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  format: z.enum(['csv', 'tsv']).optional(),
  header: z.boolean().optional(),
  where: z.string().max(100_000).optional(),
  orderBy: z.array(z.object({ column: z.string().min(1).max(200), desc: z.boolean() })).max(32).optional(),
});

const bad = (reply: FastifyReply, e: z.ZodError) =>
  reply.code(400).send({ error: 'ValidationError', issues: z.flattenError(e) });

const safeName = (s: string) => s.replace(/[^\w.-]/g, '_').slice(0, 120);

export const exportCsvRoutes: FastifyPluginAsync = async (app) => {
  // A download has to be a real browser navigation - fetch() cannot stream a response to disk
  // without buffering the whole export in memory - so the client POSTs a hidden form. Parsing
  // that single field with URLSearchParams is cheaper than a body-parser dependency, and the
  // parser is scoped to this plugin so no other route changes behaviour.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const payload = new URLSearchParams(body as string).get('payload');
        done(null, payload ? JSON.parse(payload) : {});
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.post('/api/connections/:id/export', async (req, reply) => {
    const user = requireUser(req);
    const p = Params.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = Body.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);

    const row = await loadConnection(p.data.id, user.id);
    if (!row) return reply.code(404).send({ error: 'no such connection' });
    const cfg = targetConfig(row);

    const tsv = b.data.format === 'tsv';
    let source: string;
    let filename: string;
    if (b.data.sql !== undefined) {
      const stmts = splitStatements(b.data.sql);
      const only = stmts[0];
      if (stmts.length !== 1 || !only) {
        return reply.code(400).send({ error: 'export takes exactly one statement' });
      }
      // splitStatements already stripped the trailing semicolon that COPY (...) would choke on
      source = `(${only.sql})`;
      filename = `export.${tsv ? 'tsv' : 'csv'}`;
    } else if (b.data.schema !== undefined && b.data.name !== undefined) {
      // Via tableSelect, so the filter and sort the user is looking at in the browser end up in
      // the file. A bare COPY <table> would quietly export every row instead.
      source = `(${await tableSelect(cfg, {
        schema: b.data.schema,
        name: b.data.name,
        where: b.data.where,
        orderBy: b.data.orderBy,
      })})`;
      filename = `${safeName(b.data.schema)}.${safeName(b.data.name)}.${tsv ? 'tsv' : 'csv'}`;
    } else {
      return reply.code(400).send({ error: 'provide either sql, or schema and name' });
    }

    const copySql = `COPY ${source} TO STDOUT WITH (FORMAT csv, HEADER ${
      b.data.header === false ? 'false' : 'true'
    }${tsv ? ", DELIMITER E'\\t'" : ''})`;

    // ponytail: the export runs on a fresh pooled connection, so session-local temp tables,
    // SET LOCAL settings and open transactions are invisible to it; upgrade path is running the
    // COPY on the session's pinned connection when the client passes a sessionId.
    const client = await poolFor(cfg).connect();
    let broken = false;
    try {
      const copy = client.query(to(copySql));
      // a bad statement fails before the first byte: wait for it, so we don't answer 200 + attachment
      // and then truncate the file. 'readable' does not consume, pipeline still gets every byte.
      await new Promise<void>((resolve, reject) => {
        copy.once('error', reject);
        copy.once('readable', resolve);
        copy.once('end', resolve);
      });
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': tsv ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      });
      await pipeline(copy, reply.raw);
    } catch (err) {
      broken = true; // a connection abandoned mid-COPY is unusable: release(true) destroys it
      if (reply.raw.headersSent) reply.raw.destroy();
      else return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release(broken);
    }
  });
};
