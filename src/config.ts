import { z } from 'zod';

const envSchema = z.object({
  REDIS_URL: z.string().default('redis://localhost:6379'),
  HL_WS_URL: z.string().default('wss://api.hyperliquid.xyz/ws'),
  HL_API_URL: z.string().default('https://api.hyperliquid.xyz'),
  PORT: z.coerce.number().default(3000),
  DEFAULT_BALANCE: z.coerce.number().default(10_000_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WS_RECONNECT_MIN_MS: z.coerce.number().default(1000),
  WS_RECONNECT_MAX_MS: z.coerce.number().default(30000),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
