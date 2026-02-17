import { getUserFillsPg, getUserFillsByTimePg } from '../store/pg-queries.js';
import type { PaperFill } from '../types/order.js';

export async function getUserFills(userId: string, limit = 100): Promise<PaperFill[]> {
  return getUserFillsPg(userId, limit);
}

export async function getUserFillsByTime(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<PaperFill[]> {
  return getUserFillsByTimePg(userId, startTime, endTime);
}
