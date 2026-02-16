import { serve } from '@hono/node-server';
import { config } from './config.js';
import { connectRedis, disconnectRedis } from './store/redis.js';
import { Worker } from './worker/index.js';
import { app } from './api/server.js';
import { logger } from './utils/logger.js';

let worker: Worker;

async function main() {
  logger.info('Starting HyPaper backend...');

  // Connect to Redis
  await connectRedis();
  logger.info('Redis connected');

  // Start worker (fetches market data, connects WS)
  worker = new Worker();
  await worker.start();

  // Start HTTP server
  serve({
    fetch: app.fetch,
    port: config.PORT,
  }, (info) => {
    logger.info({ port: info.port }, 'HyPaper server running');
  });
}

async function shutdown() {
  logger.info('Shutting down...');
  worker?.stop();
  await disconnectRedis();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
