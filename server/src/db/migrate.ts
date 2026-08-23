import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metaPool } from './index.js';

// ponytail: hand-rolled migrator instead of drizzle-kit migrate -- it is ~30 lines against
// drizzle-kit's journal/snapshot machinery and needs no extra runtime dep. Switch to
// `drizzle-orm/node-postgres/migrator` once migrations multiply or need down-steps.

/** Arbitrary but fixed: every replica must pick the same lock key. */
const LOCK_KEY = 5274_0001;

function findMigrationsDir(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; ) {
    const candidate = join(dir, 'migrations');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) throw new Error('migrations directory not found');
    dir = up;
  }
}

export async function ensureSchema(log?: (m: string) => void): Promise<void> {
  const dir = findMigrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await metaPool.connect();
  try {
    for (const file of files) {
      await client.query('BEGIN');
      try {
        // xact lock: released at COMMIT/ROLLBACK, so a second replica just waits and then
        // sees the row already recorded. Also serialises the CREATE TABLE IF NOT EXISTS.
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        await client.query(
          `CREATE TABLE IF NOT EXISTS _sqlmypg_migrations (
             name text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now()
           )`,
        );
        const done = await client.query('SELECT 1 FROM _sqlmypg_migrations WHERE name = $1', [file]);
        if (done.rowCount) {
          await client.query('ROLLBACK');
          continue;
        }
        await client.query(await readFile(join(dir, file), 'utf8'));
        await client.query('INSERT INTO _sqlmypg_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log?.(`migration applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  } finally {
    client.release();
  }
}
