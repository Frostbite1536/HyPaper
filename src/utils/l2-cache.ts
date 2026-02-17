import { config } from '../config.js';
import { logger } from './logger.js';

export interface L2Level {
  px: string;
  sz: string;
  n: number;
}

export interface HlL2Book {
  coin: string;
  levels: [L2Level[], L2Level[]]; // [bids, asks]
  time: number;
}

interface CacheEntry {
  book: HlL2Book;
  ts: number;
}

const CACHE_TTL_MS = 2000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<HlL2Book | null>>();

async function fetchL2Book(coin: string): Promise<HlL2Book | null> {
  try {
    const res = await fetch(`${config.HL_API_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'l2Book', coin }),
    });
    if (!res.ok) {
      logger.warn({ coin, status: res.status }, 'L2 book fetch failed');
      return null;
    }
    const data = (await res.json()) as { levels: [[{ px: string; sz: string; n: number }], [{ px: string; sz: string; n: number }]] };
    return {
      coin,
      levels: data.levels as [L2Level[], L2Level[]],
      time: Date.now(),
    };
  } catch (err) {
    logger.warn({ err, coin }, 'L2 book fetch error');
    return null;
  }
}

export async function getL2Book(coin: string): Promise<HlL2Book | null> {
  const cached = cache.get(coin);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.book;
  }

  // Deduplicate concurrent fetches
  const existing = inflight.get(coin);
  if (existing) return existing;

  const promise = fetchL2Book(coin).then((book) => {
    inflight.delete(coin);
    if (book) {
      cache.set(coin, { book, ts: Date.now() });
    }
    return book;
  });

  inflight.set(coin, promise);
  return promise;
}
