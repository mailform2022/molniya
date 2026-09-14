import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, saltHex, keyHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hmac(data: string, secret = env.SERVER_SECRET): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

const encKey = () => createHash('sha256').update(env.ADMIN_2FA_ENC_KEY).digest();

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

export function decryptSecret(blob: string): string {
  const [ivHex, tagHex, encHex] = blob.split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('bad blob');
  const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
}

/**
 * Device auth token: 32 bytes = HMAC(UID | plan | expires) — verifiable by firmware holding
 * a per-device derived key. The transmitter stores only the token + expiry.
 */
export function deviceAuthToken(uid: string, planCode: string, expiresAtUnix: number): Buffer {
  return createHmac('sha256', env.SERVER_SECRET).update(`${uid.toLowerCase()}|${planCode}|${expiresAtUnix}`).digest();
}
