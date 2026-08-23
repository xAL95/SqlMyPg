import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

/** Metadata only (users, connections, history) - user databases get their own pools per session. */
export const metaPool = new Pool({ connectionString: env.APP_DATABASE_URL, max: 10 });

// An idle client whose socket dies emits on the pool, and an unhandled 'error' event takes the
// process down with it - pg/pool.ts guards the target pools the same way.
metaPool.on('error', (err) => console.error(`[metaPool] idle client error: ${err.message}`));

export const db = drizzle(metaPool, { schema });

export async function closeDb(): Promise<void> {
  await metaPool.end();
}
