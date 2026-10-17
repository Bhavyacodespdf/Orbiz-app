import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
} from 'node:crypto';
import { env } from '../../config/env.js';

/*
 * Pickup credentials: a short numeric code (typed at the counter) and a 256-bit QR token, both
 * from the operating system's CSPRNG. The database stores:
 *   - keyed hashes (HMAC-SHA256) for lookup — useless without the server key, so a leaked
 *     database can't be brute-forced offline over the small numeric space;
 *   - an AES-256-GCM sealed copy bound to the order, so the owning student can see the same code
 *     again on another visit or device.
 * Both keys are derived from SESSION_SECRET with HKDF (separate purposes, nothing new to configure).
 * Plain codes and tokens are never logged, audited or stored.
 */

const derive = (purpose: string) =>
  Buffer.from(hkdfSync('sha256', env.SESSION_SECRET, 'campuscart-pickup', purpose, 32));
const HMAC_KEY = derive('lookup-hmac-v1');
const SEAL_KEY = derive('seal-aes-gcm-v1');

export const QR_PREFIX = 'CCPICKUP1.';

const hmac = (value: string) => createHmac('sha256', HMAC_KEY).update(value).digest('hex');
export const hashCode = (code: string) => hmac(`code:${code}`);
export const hashToken = (token: string) => hmac(`qr:${token}`);
/** Challenge tokens are already 256-bit random: a plain hash is enough. */
export const hashChallenge = (token: string) => createHash('sha256').update(token).digest('hex');

/** Codes that are too easy to guess or mistype-match (000000, 111111, 123456, 987654…). */
export function isWeakCode(code: string): boolean {
  if (/^(\d)\1+$/.test(code)) return true;
  const digits = [...code].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => (d - digits[i]! + 10) % 10));
  return steps.size === 1 && (steps.has(1) || steps.has(9));
}

/** A uniformly random code of `digits` digits (leading zeros allowed), never a weak pattern. */
export function newNumericCode(digits: number): string {
  for (;;) {
    const code = String(randomInt(0, 10 ** digits)).padStart(digits, '0');
    if (!isWeakCode(code)) return code;
  }
}

export const newToken = () => randomBytes(32).toString('base64url');

/** The QR payload is the token with a version prefix — nothing personal. */
export const qrPayload = (token: string) => `${QR_PREFIX}${token}`;

/** Accepts a scanned payload (or a bare token) and returns the token, or null if malformed. */
export function tokenFromQr(payload: string): string | null {
  const raw = payload.trim();
  const token = raw.startsWith(QR_PREFIX) ? raw.slice(QR_PREFIX.length) : raw;
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/** Seals the code and token for one order (the order ID is authenticated data). */
export function seal(secret: { code: string; token: string }, orderId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SEAL_KEY, iv);
  cipher.setAAD(Buffer.from(orderId));
  const body = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(sealed: string, orderId: string): { code: string; token: string } {
  const raw = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', SEAL_KEY, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(orderId));
  decipher.setAuthTag(raw.subarray(12, 28));
  const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
    'utf8',
  );
  return JSON.parse(text) as { code: string; token: string };
}
