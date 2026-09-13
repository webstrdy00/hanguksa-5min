import process from 'node:process';
import { buildApp } from './app.ts';
import { env } from './config/env.ts';
import { closeDb } from './db/client.ts';
import { startDeletionWorker } from './jobs/deletion-worker.ts';
import { createDeletionAlerts, createMonitoredDeletionBatch } from './jobs/deletion-alerts.ts';
import { logger } from './observability/logger.ts';
import { getDeletionQueueHealth, runPendingDeletionJobs } from './services/deletion.ts';

/**
 * 서버 진입점.
 * 종료 신호를 받으면 처리 중인 요청을 마무리하고 DB 커넥션을 정리한다.
 */
async function main(): Promise<void> {
  const app = await buildApp();
  const deletionWorker: { stop?: () => Promise<void> } = {};
  app.addHook('onClose', async () => {
    await deletionWorker.stop?.();
  });

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
  deletionWorker.stop = startDeletionWorker(
    createMonitoredDeletionBatch(
      () => runPendingDeletionJobs(),
      () => getDeletionQueueHealth(),
      createDeletionAlerts(env.DISCORD_ALERT_WEBHOOK_URL, env.APP_ENV, () =>
        logger.error('deletion_alert_delivery_failed'),
      ),
    ),
    () => logger.error('deletion_worker_failed'),
  );
  logger.info({ enabled: env.DISCORD_ALERT_WEBHOOK_URL != null }, 'deletion_alerts_configured');
  logger.info({ host: env.HOST, port: env.PORT }, 'server_started');
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'server_start_failed');
  process.exit(1);
});
