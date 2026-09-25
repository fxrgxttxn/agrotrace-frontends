/** Process start/stop shared by the three entrypoints: fail-fast config, SIGTERM/SIGINT graceful shutdown. */
import { ConfigError, loadConfig, type Config } from './config.js';
import type { Logger } from './logger.js';

export function configOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`agrotrace-express: ${err.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
}

/**
 * Runs `stop` once on SIGTERM/SIGINT; the process exits 0 when it resolves, 1 if it fails or takes longer than
 * `timeoutMs` (a stuck dependency never blocks `docker compose stop` past its own grace period).
 */
export function onShutdown(logger: Logger, timeoutMs: number, stop: () => Promise<void>): void {
  let stopping = false;
  const handler = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error('shutdown timed out');
      process.exit(1);
    }, timeoutMs + 2000);
    timer.unref();
    stop().then(
      () => {
        logger.info('stopped');
        process.exit(0);
      },
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

export function crashOnUnhandled(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}
