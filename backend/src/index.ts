import process from 'node:process';
import { buildApp } from './app.ts';
import { env } from './config/env.ts';
import { closeDb } from './db/client.ts';
import { closeDeletionJournal } from './deletion-journal/runtime.ts';
import { createDeletionAlerts, createMonitoredDeletionBatch } from './jobs/deletion-alerts.ts';
import { startPeriodicWorker } from './jobs/periodic-worker.ts';
import { logger } from './observability/logger.ts';
import {
  getDeletionQueueHealth,
  replayDeletionJournal,
  runPendingDeletionJobs,
} from './services/deletion.ts';
import { runPendingMasteryRecalcJobs } from './services/mastery-jobs.ts';

/**
 * 서버 진입점.
 * 종료 신호를 받으면 처리 중인 요청을 마무리하고 DB 커넥션을 정리한다.
 */
async function main(): Promise<void> {
  const app = await buildApp();
  const stopWorkers: (() => Promise<void>)[] = [];
  app.addHook('onClose', async () => {
    await Promise.all(stopWorkers.map((stop) => stop()));
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown_started');
    void (async () => {
      try {
        await app.close();
        await closeDb();
        await closeDeletionJournal();
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

  await replayDeletionJournal();
  await app.listen({ host: env.HOST, port: env.PORT });
  stopWorkers.push(
    startPeriodicWorker(
      createMonitoredDeletionBatch(
        () => runPendingDeletionJobs(),
        () => getDeletionQueueHealth(),
        createDeletionAlerts(env.DISCORD_ALERT_WEBHOOK_URL, env.APP_ENV, () =>
          logger.error('deletion_alert_delivery_failed'),
        ),
      ),
      () => logger.error('deletion_worker_failed'),
    ),
    startPeriodicWorker(
      () => runPendingMasteryRecalcJobs(),
      () => logger.error('mastery_recalc_worker_failed'),
    ),
  );
  logger.info({ enabled: env.DISCORD_ALERT_WEBHOOK_URL != null }, 'deletion_alerts_configured');
  logger.info({ host: env.HOST, port: env.PORT }, 'server_started');
}

main().catch(() => {
  // PostgreSQL driver 오류에 연결정보가 포함될 수 있어 시작 실패 원문은 기록하지 않는다.
  logger.fatal('server_start_failed');
  process.exit(1);
});
