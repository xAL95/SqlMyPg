import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Nearest ancestor holding package.json = the server package, in src/ and dist/ layouts alike. */
function findUp(name: string, from: string): string | null {
  for (let dir = from; ; ) {
    if (existsSync(join(dir, name))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const pkgDir = findUp('package.json', dirname(fileURLToPath(import.meta.url))) ?? process.cwd();
const rootDir = dirname(pkgDir);

// ponytail: no multi-line values, no inline `#` comments, no `${VAR}` expansion -- add a dotenv
// dependency if a deployment ever needs them; until then real env vars cover the gap.
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key || process.env[key] !== undefined) continue; // a real env var always wins
    let value = trimmed.slice(eq + 1).trim();
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

loadDotEnv(join(rootDir, '.env'));

const int = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);
/** process.env is always strings; accept the four spellings people actually type. */
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: int(5274),

  APP_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  APP_SECRET: z.string().min(32, 'must be at least 32 characters'),

  SESSION_IDLE_TIMEOUT_MS: int(1_800_000),
  SESSION_MAX_PER_USER: int(20),
  DEFAULT_STATEMENT_TIMEOUT_MS: int(120_000, 0), // 0 disables
  DEFAULT_MAX_ROWS: int(1_000),
  MAX_MAX_ROWS: int(100_000),

  LOCAL_AUTH: bool(true),

  OIDC_ISSUER: z.string().min(1).optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().min(1).optional(),
  OIDC_LABEL: z.string().min(1).default('Single sign-on'),

  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(false),

  WEB_DIST: z.string().min(1).default('../web/dist'),
});

// An empty value means "not set", everywhere: .env.example ships the optional keys blank, and
// Docker Compose turns `OIDC_ISSUER:` with no value into "". Dropping them here is what lets
// .optional() and .default() do their job instead of failing a min(1) check on first boot.
const parsed = schema.safeParse(
  Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== '')),
);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`Invalid environment:\n${issues}`);
  process.exit(1);
}

export const oidcEnabled = Boolean(
  parsed.data.OIDC_ISSUER &&
    parsed.data.OIDC_CLIENT_ID &&
    parsed.data.OIDC_CLIENT_SECRET &&
    parsed.data.OIDC_REDIRECT_URI,
);

export const env = Object.freeze({
  ...parsed.data,
  WEB_DIST: resolve(pkgDir, parsed.data.WEB_DIST),
  oidcEnabled,
});

/** /api/health reports this; pkgDir is already resolved above, so no second walk-up. */
export const version: string =
  (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
