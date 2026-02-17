import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import * as schema from './schema.js';

let sql: ReturnType<typeof postgres>;

export let db: ReturnType<typeof drizzle<typeof schema>>;

export async function connectDb(): Promise<void> {
  sql = postgres(config.DATABASE_URL, { max: 10 });
  db = drizzle(sql, { schema });

  // Verify the connection works
  try {
    await sql`SELECT 1`;
    logger.info('Postgres connected');
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to Postgres');
    throw new Error('Could not connect to Postgres. Check DATABASE_URL in your .env file.');
  }
}

export async function disconnectDb(): Promise<void> {
  if (sql) {
    await sql.end();
    logger.info('Postgres disconnected');
  }
}
