import { createApp } from './app';
import { config } from './config';
import { startNotificationConsumerLoop } from './workers/notificationConsumer';
import { pool } from './db/pool';

const app = createApp();

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Fresh Portal R1 pilot server listening on port ${config.port} (env=${config.nodeEnv})`);
});

startNotificationConsumerLoop(500);

function shutdown() {
  // eslint-disable-next-line no-console
  console.log('Shutting down...');
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
