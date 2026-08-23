import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { env } from './env.js';

/** Importing env means it is already validated, so deriving here is safe. ~100ms once at boot. */
const credKey = scryptSync(env.APP_SECRET, 'sqlmypg.creds.v1', 32);

const b64 = (b: Buffer): string => b.toString('base64url');

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ct)}`;
}

export function decryptSecret(blob: string): string {
  const parts = blob.split('.');
  const [version, ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 4 || version !== 'v1' || !ivB64 || !tagB64 || ctB64 === undefined) {
    throw new Error('decryptSecret: malformed ciphertext');
  }
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('decryptSecret: malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', credKey, iv);
  decipher.setAuthTag(tag);
  // final() throws on a bad tag, which is exactly the tamper signal we want to propagate
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function hashPassword(pw: string): string {
  const salt = randomBytes(32);
  const hash = scryptSync(pw, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt.${SCRYPT_N}.${SCRYPT_R}.${SCRYPT_P}.${b64(salt)}.${b64(hash)}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const parts = stored.split('.');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [n, r, p, saltB64, hashB64] = [parts[1], parts[2], parts[3], parts[4], parts[5]];
    const N = Number(n);
    const R = Number(r);
    const P = Number(p);
    if (!saltB64 || !hashB64 || !Number.isSafeInteger(N) || !Number.isSafeInteger(R) || !Number.isSafeInteger(P)) {
      return false;
    }
    // refuse absurd cost params instead of letting a crafted row DoS the login route
    if (N < 1024 || N > 1 << 20 || R < 1 || R > 32 || P < 1 || P > 16) return false;
    const expected = Buffer.from(hashB64, 'base64url');
    if (expected.length === 0) return false;
    const actual = scryptSync(pw, Buffer.from(saltB64, 'base64url'), expected.length, {
      N,
      r: R,
      p: P,
      maxmem: 256 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 21 chars of base64url = 126 bits. Every primary key in the app. */
export function newId(): string {
  return randomBytes(16).toString('base64url').slice(0, 21);
}
