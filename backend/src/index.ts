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
import { getMasteryQueuePending, runPendingMasteryRecalcJobs } from './services/mastery-jobs.ts';

/**
 * 서버 진입점.
 * 종료 신호를 받으면 처리 중인 요청을 마무리하고 DB 커넥션을 정리한다.
 */
async function main(): Promise<void> {
  const app = await buildApp();
  const stopWorkers: (() => Promise<void>)[] = [];
  let shuttingDown = false;
  const startup: { promise?: Promise<void> } = {};
  let deletionWorker: ReturnType<typeof startPeriodicWorker> | undefined;
  let masteryWorker: ReturnType<typeof startPeriodicWorker> | undefined;
  app.addHook('onClose', async () => {
    await Promise.all(stopWorkers.map((stop) => stop()));
  });
  app.addHook('onResponse', (request, reply, done) => {
    if (
      shuttingDown ||
      !(
        (reply.statusCode >= 200 && reply.statusCode < 300) ||
        (reply.statusCode >= 500 && reply.statusCode < 600)
      )
    ) {
      done();
      return;
    }
    if (
      request.method === 'DELETE' &&
      request.routeOptions.url === '/v1/account' &&
      request.authenticatedUser != null
    ) {
      deletionWorker?.wake();
    }
    if (
      request.method === 'PATCH' &&
      request.routeOptions.url === '/admin/v1/revisions/:id/status' &&
      request.authenticatedAdmin != null
    ) {
      masteryWorker?.wake();
    }
    done();
  });

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown_started');
    void (async () => {
      try {
        await startup.promise?.catch(() => undefined);
        await app.close();
        await closeDb();
        await closeDeletionJournal();
        logger.info('shutdown_completed');
        process.exit(0);
      } catch {
        logger.error('shutdown_failed');
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

  startup.promise = (async () => {
    await replayDeletionJournal();
    if (shuttingDown) return;

    const deletionAlerts = createDeletionAlerts(env.DISCORD_ALERT_WEBHOOK_URL, env.APP_ENV, () =>
      logger.error('deletion_alert_delivery_failed'),
    );
    let deletionPending = true;
    const deletionBatch = createMonitoredDeletionBatch(
      () => runPendingDeletionJobs(),
      () => getDeletionQueueHealth(),
      deletionAlerts,
      (health) => {
        // pending을 모르는 호출자는 빈 큐라고 단정하지 않는다.
        deletionPending = health.pending !== 0;
      },
    );
    deletionWorker = startPeriodicWorker(
      async () => {
        await deletionBatch();
        return deletionPending || deletionAlerts.hasPendingDelivery();
      },
      () => logger.error('deletion_worker_failed'),
    );
    stopWorkers.push(deletionWorker);
    masteryWorker = startPeriodicWorker(
      async () => {
        await runPendingMasteryRecalcJobs();
        return await getMasteryQueuePending();
      },
      () => logger.error('mastery_recalc_worker_failed'),
    );
    stopWorkers.push(masteryWorker);

    await app.listen({ host: env.HOST, port: env.PORT });
    if (shuttingDown) return;
    logger.info({ enabled: env.DISCORD_ALERT_WEBHOOK_URL != null }, 'deletion_alerts_configured');
    logger.info({ host: env.HOST, port: env.PORT }, 'server_started');
  })();

  try {
    await startup.promise;
  } catch (error) {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    throw error;
  }
}

main().catch(() => {
  // PostgreSQL driver 오류에 연결정보가 포함될 수 있어 시작 실패 원문은 기록하지 않는다.
  logger.fatal('server_start_failed');
  process.exit(1);
});
