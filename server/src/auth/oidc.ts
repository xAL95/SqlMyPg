import * as client from 'openid-client';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { CurrentUser } from '@shared/protocol.js';
import { env } from '../env.js';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { clearCookie, readSignedCookie, setSessionCookie, setSignedCookie, toUser } from './plugin.js';

const OIDC_COOKIE = 'sqlmypg_oidc';
const OIDC_COOKIE_MAX_AGE = 600;

let configPromise: Promise<client.Configuration> | undefined;

function oidcConfig(): Promise<client.Configuration> {
  configPromise ??= client
    .discovery(new URL(env.OIDC_ISSUER!), env.OIDC_CLIENT_ID!, env.OIDC_CLIENT_SECRET)
    .catch((err: unknown) => {
      configPromise = undefined; // a provider that was down at first request must be retryable
      throw err;
    });
  return configPromise;
}

/** Never show the user a provider error page: back to the app with a short reason. */
function fail(reply: FastifyReply, reason: string) {
  clearCookie(reply, OIDC_COOKIE);
  return reply.redirect(`/?authError=${encodeURIComponent(reason)}`, 302);
}

const userCols = {
  id: users.id,
  email: users.email,
  name: users.name,
  isAdmin: users.isAdmin,
  provider: users.provider,
};

async function upsertByEmail(email: string, name: string | null): Promise<CurrentUser> {
  const found = await db.select(userCols).from(users).where(eq(users.email, email)).limit(1);
  const existing = found[0];
  if (existing) return toUser(existing); // keep whatever provider / password the account already has
  const others = await db.select({ id: users.id }).from(users).limit(1);
  const rows = await db
    .insert(users)
    .values({
      id: newId(),
      email,
      name,
      passwordHash: null,
      isAdmin: others.length === 0,
      provider: 'oidc',
    })
    .returning(userCols);
  const row = rows[0];
  if (!row) throw new Error('user insert returned nothing');
  return toUser(row);
}

export const oidcRoutes: FastifyPluginAsync = async (fastify) => {
  if (!env.oidcEnabled) return;

  const redirectUri = env.OIDC_REDIRECT_URI!;

  fastify.get('/api/auth/oidc/start', async (req, reply) => {
    try {
      const config = await oidcConfig();
      const verifier = client.randomPKCECodeVerifier();
      const challenge = await client.calculatePKCECodeChallenge(verifier);
      const state = client.randomState();
      setSignedCookie(reply, OIDC_COOKIE, JSON.stringify({ state, verifier }), OIDC_COOKIE_MAX_AGE);
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return reply.redirect(url.href, 302);
    } catch (err) {
      req.log.warn({ err }, 'oidc start failed');
      return fail(reply, 'single sign-on is unavailable');
    }
  });

  fastify.get('/api/auth/oidc/callback', async (req, reply) => {
    const stored = readSignedCookie(req, OIDC_COOKIE);
    if (!stored) return fail(reply, 'sign-in took too long, try again');
    try {
      const parsed = JSON.parse(stored) as { state?: unknown; verifier?: unknown };
      if (typeof parsed.state !== 'string' || typeof parsed.verifier !== 'string') {
        return fail(reply, 'sign-in took too long, try again');
      }
      const config = await oidcConfig();
      // build the current URL from the configured redirect_uri, never from the Host header;
      // openid-client strips the query off it to send as redirect_uri to the token endpoint
      const currentUrl = new URL(redirectUri);
      currentUrl.search = new URL(req.url, 'http://localhost').search;
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: parsed.verifier,
        expectedState: parsed.state,
      });
      const claims = tokens.claims();
      const email = typeof claims?.email === 'string' ? claims.email.trim().toLowerCase() : '';
      if (!email) {
        clearCookie(reply, OIDC_COOKIE);
        return reply.code(400).send({ message: 'The identity provider returned no email address' });
      }
      const name = typeof claims?.name === 'string' && claims.name.trim() !== '' ? claims.name.trim() : null;
      const user = await upsertByEmail(email, name);
      clearCookie(reply, OIDC_COOKIE);
      setSessionCookie(reply, user);
      return reply.redirect('/', 302);
    } catch (err) {
      req.log.warn({ err }, 'oidc callback failed');
      return fail(reply, 'single sign-on failed');
    }
  });
};
