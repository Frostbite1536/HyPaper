import { nanoid } from 'nanoid';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';

export function generateApiKey(): string {
  return `hp_${nanoid(32)}`;
}

export function generateUserId(): string {
  // Generate a mock 0x address
  const hex = nanoid(40).replace(/[^a-f0-9]/gi, '').slice(0, 40).toLowerCase();
  const padded = hex.padEnd(40, '0');
  return `0x${padded}`;
}

export async function nextOid(): Promise<number> {
  return redis.incr(KEYS.SEQ_OID);
}

export async function nextTid(): Promise<number> {
  return redis.incr(KEYS.SEQ_TID);
}
