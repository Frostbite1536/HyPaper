import { getLmUserFillsPg, getLmUserFillsByTimePg } from '../store/pg-queries.js';
import type { LmPaperFill } from '../types/limitless-order.js';

export async function getLmUserFills(userId: string, limit = 100): Promise<LmPaperFill[]> {
  return getLmUserFillsPg(userId, limit);
}

export async function getLmUserFillsByTime(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<LmPaperFill[]> {
  return getLmUserFillsByTimePg(userId, startTime, endTime);
}
