import process from 'node:process';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { createDeletionAlerts, createMonitoredDeletionBatch } from './jobs/deletion-alerts.ts';
import type { startPeriodicWorker } from './jobs/periodic-worker.ts';

const mocks = vi.hoisted(() => {
  const app = {
    addHook: vi.fn<(name: string, hook: () => Promise<void>) => void>(),
    listen: vi.fn<() => Promise<string>>(),
    close: vi.fn<() => Promise<void>>(),
  };
  return {
    app,
    buildApp: vi.fn<() => Promise<typeof app>>(),
    replayDeletionJournal: vi.fn<() => Promise<void>>(),
    closeDb: vi.fn<() => Promise<void>>(),
    closeDeletionJournal: vi.fn<() => Promise<void>>(),
    startPeriodicWorker: vi.fn<typeof startPeriodicWorker>(),
    stopDeletion: vi.fn<() => Promise<void>>(),
    stopMastery: vi.fn<() => Promise<void>>(),
    runPendingDeletionJobs: vi.fn<() => Promise<number>>(),
    getDeletionQueueHealth: vi.fn<() => Promise<{ failed: number; overdue: number }>>(),
    runPendingMasteryRecalcJobs: vi.fn<() => Promise<unknown[]>>(),
    createDeletionAlerts: vi.fn<typeof createDeletionAlerts>(),
    createMonitoredDeletionBatch: vi.fn<typeof createMonitoredDeletionBatch>(),
    deletionBatch: vi.fn<() => Promise<number>>(),
    deletionAlerts:
      vi.fn<(state: { failed: number; overdue: number; unavailable: boolean }) => Promise<void>>(),
    logger: { info: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  };
});

vi.mock('./app.ts', () => ({ buildApp: mocks.buildApp }));
vi.mock('./config/env.ts', () => ({
  env: {
    HOST: '127.0.0.1',
    PORT: 8080,
    APP_ENV: 'dev',
    DISCORD_ALERT_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/MOCK_TEST_ONLY',
  },
}));
vi.mock('./db/client.ts', () => ({ closeDb: mocks.closeDb }));
vi.mock('./deletion-journal/runtime.ts', () => ({
  closeDeletionJournal: mocks.closeDeletionJournal,
}));
vi.mock('./jobs/periodic-worker.ts', () => ({ startPeriodicWorker: mocks.startPeriodicWorker }));
vi.mock('./jobs/deletion-alerts.ts', () => ({
  createDeletionAlerts: mocks.createDeletionAlerts,
  createMonitoredDeletionBatch: mocks.createMonitoredDeletionBatch,
}));
vi.mock('./services/deletion.ts', () => ({
  replayDeletionJournal: mocks.replayDeletionJournal,
  runPendingDeletionJobs: mocks.runPendingDeletionJobs,
  getDeletionQueueHealth: mocks.getDeletionQueueHealth,
}));
vi.mock('./services/mastery-jobs.ts', () => ({
  runPendingMasteryRecalcJobs: mocks.runPendingMasteryRecalcJobs,
}));
vi.mock('./observability/logger.ts', () => ({ logger: mocks.logger }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let processOnSpy: MockInstance<typeof process.on>;
let processExitSpy: MockInstance<typeof process.exit>;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  mocks.buildApp.mockResolvedValue(mocks.app);
  mocks.replayDeletionJournal.mockResolvedValue(undefined);
  mocks.app.listen.mockResolvedValue('http://127.0.0.1:8080');
  mocks.app.close.mockImplementation(async () => {
    const hook = mocks.app.addHook.mock.calls.find(([name]) => name === 'onClose')?.[1];
    if (hook == null) throw new Error('MOCK missing onClose hook');
    await hook();
  });
  mocks.closeDb.mockResolvedValue(undefined);
  mocks.closeDeletionJournal.mockResolvedValue(undefined);
  mocks.stopDeletion.mockResolvedValue(undefined);
  mocks.stopMastery.mockResolvedValue(undefined);
  mocks.startPeriodicWorker
    .mockReturnValueOnce(mocks.stopDeletion)
    .mockReturnValueOnce(mocks.stopMastery);
  mocks.runPendingDeletionJobs.mockResolvedValue(1);
  mocks.getDeletionQueueHealth.mockResolvedValue({ failed: 0, overdue: 0 });
  mocks.runPendingMasteryRecalcJobs.mockResolvedValue([]);
  mocks.deletionBatch.mockResolvedValue(1);
  mocks.deletionAlerts.mockResolvedValue(undefined);
  mocks.createDeletionAlerts.mockReturnValue(mocks.deletionAlerts);
  mocks.createMonitoredDeletionBatch.mockReturnValue(mocks.deletionBatch);
});

afterEach(() => vi.restoreAllMocks());

async function startServer(): Promise<void> {
  await import('./index.ts');
  await vi.waitFor(() => expect(mocks.startPeriodicWorker).toHaveBeenCalledTimes(2));
}

function signalServer(signal: 'SIGTERM' | 'SIGINT'): void {
  const handler = processOnSpy.mock.calls.find(([name]) => name === signal)?.[1];
  if (handler == null) throw new Error('MOCK missing signal handler');
  handler();
}

it('삭제 원장 재이행과 listen 성공 뒤 두 배치를 시작하고 기존 삭제 알림을 유지한다', async () => {
  const replay = deferred<void>();
  const listening = deferred<string>();
  mocks.replayDeletionJournal.mockReturnValueOnce(replay.promise);
  mocks.app.listen.mockReturnValueOnce(listening.promise);
  await import('./index.ts');
  await vi.waitFor(() => expect(mocks.replayDeletionJournal).toHaveBeenCalledTimes(1));
  expect(mocks.app.listen).not.toHaveBeenCalled();
  expect(mocks.startPeriodicWorker).not.toHaveBeenCalled();

  replay.resolve(undefined);
  await vi.waitFor(() => expect(mocks.app.listen).toHaveBeenCalledTimes(1));
  expect(mocks.app.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8080 });
  expect(mocks.startPeriodicWorker).not.toHaveBeenCalled();
  listening.resolve('http://127.0.0.1:8080');
  await vi.waitFor(() => expect(mocks.startPeriodicWorker).toHaveBeenCalledTimes(2));

  const [runDeletion, inspectDeletion, notify] = mocks.createMonitoredDeletionBatch.mock.calls[0]!;
  await runDeletion();
  await inspectDeletion();
  expect(mocks.runPendingDeletionJobs).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.getDeletionQueueHealth).toHaveBeenCalledExactlyOnceWith();
  expect(notify).toBe(mocks.deletionAlerts);
  expect(mocks.createDeletionAlerts).toHaveBeenCalledExactlyOnceWith(
    'https://discord.com/api/webhooks/123/MOCK_TEST_ONLY',
    'dev',
    expect.any(Function),
  );
  await mocks.startPeriodicWorker.mock.calls[0]![0]();
  await mocks.startPeriodicWorker.mock.calls[1]![0]();
  expect(mocks.deletionBatch).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.runPendingMasteryRecalcJobs).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.logger.info).toHaveBeenCalledWith({ enabled: true }, 'deletion_alerts_configured');
  expect(mocks.logger.info).toHaveBeenCalledWith(
    { host: '127.0.0.1', port: 8080 },
    'server_started',
  );
});

it.each(['build', 'replay', 'listen'] as const)(
  '%s 실패 시 워커를 시작하지 않는다',
  async (stage) => {
    const steps = {
      build: mocks.buildApp,
      replay: mocks.replayDeletionJournal,
      listen: mocks.app.listen,
    };
    steps[stage].mockRejectedValueOnce(new Error('MOCK sensitive connection information'));
    await import('./index.ts');
    await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(1));
    expect(mocks.startPeriodicWorker).not.toHaveBeenCalled();
    expect(mocks.createDeletionAlerts).not.toHaveBeenCalled();
    expect(mocks.logger.fatal).toHaveBeenCalledExactlyOnceWith('server_start_failed');
    expect(mocks.logger.error).not.toHaveBeenCalled();
    if (stage === 'build') expect(mocks.replayDeletionJournal).not.toHaveBeenCalled();
    if (stage !== 'listen') expect(mocks.app.listen).not.toHaveBeenCalled();
  },
);

it('숙련도 워커 실패는 코드만 기록하고 기존 삭제 오류 코드도 유지한다', async () => {
  await startServer();
  mocks.startPeriodicWorker.mock.calls[1]![1]();
  mocks.startPeriodicWorker.mock.calls[0]![1]();
  mocks.createDeletionAlerts.mock.calls[0]![2]();
  expect(mocks.logger.error.mock.calls).toEqual([
    ['mastery_recalc_worker_failed'],
    ['deletion_worker_failed'],
    ['deletion_alert_delivery_failed'],
  ]);
});

it.each(['SIGTERM', 'SIGINT'] as const)(
  '%s 종료 시 두 워커를 동시에 기다린 뒤 DB를 닫는다',
  async (signal) => {
    await startServer();
    const deletionStopped = deferred<void>();
    const masteryStopped = deferred<void>();
    mocks.stopDeletion.mockReturnValueOnce(deletionStopped.promise);
    mocks.stopMastery.mockReturnValueOnce(masteryStopped.promise);
    signalServer(signal);
    await vi.waitFor(() => {
      expect(mocks.stopDeletion).toHaveBeenCalledTimes(1);
      expect(mocks.stopMastery).toHaveBeenCalledTimes(1);
    });
    expect(mocks.app.close).toHaveBeenCalledTimes(1);
    expect(mocks.closeDb).not.toHaveBeenCalled();
    expect(mocks.closeDeletionJournal).not.toHaveBeenCalled();

    deletionStopped.resolve(undefined);
    await deletionStopped.promise;
    expect(mocks.closeDb).not.toHaveBeenCalled();
    masteryStopped.resolve(undefined);
    await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(0));
    expect(mocks.closeDb).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.closeDeletionJournal).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.closeDeletionJournal.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.closeDb.mock.invocationCallOrder[0]!,
    );
    expect(mocks.logger.info).toHaveBeenCalledWith({ signal }, 'shutdown_started');
    expect(mocks.logger.info).toHaveBeenCalledWith('shutdown_completed');
  },
);

it('워커 종료 실패 시 DB를 닫지 않고 기존 종료 실패 경로로 전달한다', async () => {
  await startServer();
  const error = new Error('MOCK worker stop failure');
  mocks.stopMastery.mockRejectedValueOnce(error);
  signalServer('SIGTERM');
  await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(1));
  expect(mocks.stopDeletion).toHaveBeenCalledTimes(1);
  expect(mocks.stopMastery).toHaveBeenCalledTimes(1);
  expect(mocks.closeDb).not.toHaveBeenCalled();
  expect(mocks.closeDeletionJournal).not.toHaveBeenCalled();
  expect(mocks.logger.error).toHaveBeenCalledExactlyOnceWith({ err: error }, 'shutdown_failed');
});
