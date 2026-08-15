import process from 'node:process';
import { buildApp } from './app.ts';
import { env } from './config/env.ts';
import { closeDb } from './db/client.ts';
import { logger } from './observability/logger.ts';

/**
 * 서버 진입점.
 * 종료 신호를 받으면 처리 중인 요청을 마무리하고 DB 커넥션을 정리한다.
 */
async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown_started');
    void (async () => {
      try {
        await app.close();
        await closeDb();
        logger.info('shutdown_completed');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'shutdown_failed');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT }, 'server_started');
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'server_start_failed');
  process.exit(1);
});
