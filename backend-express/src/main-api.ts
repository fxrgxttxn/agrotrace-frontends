/** api process: HTTP on PORT (8000). */
import type { Socket } from 'node:net';
import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadContract } from './contract.js';
import { configOrExit, crashOnUnhandled, onShutdown } from './lifecycle.js';
import { createLogger } from './logger.js';
import { createSseHub } from './sse/hub.js';

const config = configOrExit();
const logger = createLogger({ level: config.LOG_LEVEL, process: 'api' });
crashOnUnhandled(logger);
const container = createContainer(config, logger, { process: 'api', contract: loadContract() });
container.amqp.start();
container.relay.start();
container.sse = createSseHub({ db: container.db, databaseUrl: config.APP_DATABASE_URL, logger });
container.sse.start();

const app = createApp(container);
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'api listening'));
// Longer than the gateway's upstream keepalive so nginx, not Node, closes idle connections.
server.keepAliveTimeout = 75_000;
server.headersTimeout = 76_000;

const sockets = new Set<Socket>();
server.on('connection', (s) => {
  sockets.add(s);
  s.on('close', () => sockets.delete(s));
});

onShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  // Stop accepting; idle keep-alive sockets close now, in-flight requests get SHUTDOWN_TIMEOUT_MS.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // SSE streams never end on their own: close them first (clients reconnect to another instance).
  await container.sse?.close();
  server.closeIdleConnections();
  const deadline = setTimeout(() => {
    for (const s of sockets) s.destroy();
  }, config.SHUTDOWN_TIMEOUT_MS);
  await closed;
  clearTimeout(deadline);
  await container.close();
});
