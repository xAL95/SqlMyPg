import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside the app, so src/env.ts (and its .env loader) is not in play here.
const url = process.env.APP_DATABASE_URL;
if (!url) throw new Error('APP_DATABASE_URL must be set to run drizzle-kit');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
});
