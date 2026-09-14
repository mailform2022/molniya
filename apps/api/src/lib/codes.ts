import { createHmac, randomBytes } from 'node:crypto';
import { env } from './env.js';

/** Activation code format: MLN-{TYPE}-{PLAN}-{DURATION}-{DEVICES}-{SIGNATURE} */
export const CODE_TYPES = ['ACT', 'EXT', 'TST', 'SES'] as const;
export type CodeType = (typeof CODE_TYPES)[number];

export interface ParsedCode {
  type: CodeType;
  plan: string;
  durationDays: number;
  devices: number;
  nonce: string;
  signature: string;
  code: string;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easier to type on a radio encoder

function sign(parts: string[], secret = env.SERVER_SECRET): string {
  const mac = createHmac('sha256', secret).update(parts.join('-')).digest();
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[mac[i]! % ALPHABET.length];
  return out;
}

export function generateCode(type: CodeType, plan: string, durationDays: number, devices: number): ParsedCode {
  const nonceBytes = randomBytes(4);
  let nonce = '';
  for (const b of nonceBytes) nonce += ALPHABET[b % ALPHABET.length];
  const body = ['MLN', type, plan.toUpperCase(), `${durationDays}D`, `${devices}X${nonce}`];
  const signature = sign(body);
  return { type, plan: plan.toUpperCase(), durationDays, devices, nonce, signature, code: [...body, signature].join('-') };
}

export function parseCode(raw: string): ParsedCode | null {
  const code = raw.trim().toUpperCase().replace(/\s+/g, '');
  const m = /^MLN-(ACT|EXT|TST|SES)-([A-Z0-9]+)-(\d+)D-(\d+)X([A-Z0-9]{4})-([A-Z0-9]{6})$/.exec(code);
  if (!m) return null;
  const [, type, plan, dur, dev, nonce, signature] = m as unknown as [string, CodeType, string, string, string, string, string];
  const body = ['MLN', type, plan, `${dur}D`, `${dev}X${nonce}`];
  if (sign(body) !== signature) return null;
  return { type, plan, durationDays: Number(dur), devices: Number(dev), nonce, signature, code };
}

/** Compact numeric form for entering on a radio with an encoder: digits only, same HMAC truncated to 8 digits. */
export function toEncoderForm(code: ParsedCode): string {
  const mac = createHmac('sha256', env.SERVER_SECRET).update(code.code).digest();
  const num = (mac.readUInt32BE(0) % 100000000).toString().padStart(8, '0');
  const typeIdx = CODE_TYPES.indexOf(code.type);
  return `${typeIdx}${code.durationDays.toString().padStart(3, '0')}${code.devices}${num}`;
}
