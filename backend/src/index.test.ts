import process from 'node:process';
import Fastify from 'fastify';
import type { FastifyListenOptions } from 'fastify';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as DeletionAlertsModule from './jobs/deletion-alerts.ts';
import type { createDeletionAlerts, createMonitoredDeletionBatch } from './jobs/deletion-alerts.ts';
import type * as PeriodicWorkerModule from './jobs/periodic-worker.ts';
import type { startPeriodicWorker } from './jobs/periodic-worker.ts';

type CloseHook = () => Promise<void>;
type ResponseHook = (
  request: {
    method: string;
    routeOptions: { url?: string };
    authenticatedUser?: { id: string; identityStatus: string };
    authenticatedAdmin?: { id: string; role: string; email: string };
  },
  reply: { statusCode: number },
  done: () => void,
) => void;

const mocks = vi.hoisted(() => {
  const app = {
    addHook: vi.fn<(name: string, hook: CloseHook | ResponseHook) => void>(),
    listen: vi.fn<() => Promise<string>>(),
    close: vi.fn<() => Promise<void>>(),
  };
  return {
    app,
    buildApp: vi.fn<() => Promise<typeof app>>(),
    replayDeletionJournal: vi.fn<(full?: boolean) => Promise<void>>(),
    closeDb: vi.fn<() => Promise<void>>(),
    closeDeletionJournal: vi.fn<() => Promise<void>>(),
    startPeriodicWorker: vi.fn<typeof startPeriodicWorker>(),
    stopDeletion: Object.assign(vi.fn<() => Promise<void>>(), { wake: vi.fn<() => void>() }),
    stopMastery: Object.assign(vi.fn<() => Promise<void>>(), { wake: vi.fn<() => void>() }),
    runPendingDeletionJobs: vi.fn<() => Promise<number>>(),
    getDeletionQueueHealth:
      vi.fn<() => Promise<{ failed: number; overdue: number; pending: number }>>(),
    runPendingMasteryRecalcJobs: vi.fn<() => Promise<unknown[]>>(),
    getMasteryQueuePending: vi.fn<() => Promise<boolean>>(),
    createDeletionAlerts: vi.fn<typeof createDeletionAlerts>(),
    createMonitoredDeletionBatch: vi.fn<typeof createMonitoredDeletionBatch>(),
    deletionBatch: vi.fn<() => Promise<number>>(),
    deletionAlerts: Object.assign(
      vi.fn<(state: { failed: number; overdue: number; unavailable: boolean }) => Promise<void>>(),
      { hasPendingDelivery: vi.fn<() => boolean>() },
    ),
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
  getMasteryQueuePending: mocks.getMasteryQueuePending,
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

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  mocks.buildApp.mockResolvedValue(mocks.app);
  mocks.replayDeletionJournal.mockResolvedValue(undefined);
  mocks.app.listen.mockResolvedValue('http://127.0.0.1:8080');
  mocks.app.close.mockImplementation(async () => {
    const hook = mocks.app.addHook.mock.calls.find(([name]) => name === 'onClose')?.[1] as
      CloseHook | undefined;
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
  mocks.getDeletionQueueHealth.mockResolvedValue({ failed: 0, overdue: 0, pending: 0 });
  mocks.runPendingMasteryRecalcJobs.mockResolvedValue([]);
  mocks.getMasteryQueuePending.mockResolvedValue(false);
  mocks.deletionAlerts.mockResolvedValue(undefined);
  mocks.deletionAlerts.hasPendingDelivery.mockReturnValue(false);
  mocks.createDeletionAlerts.mockReturnValue(mocks.deletionAlerts);
  const actual = await vi.importActual<typeof DeletionAlertsModule>('./jobs/deletion-alerts.ts');
  mocks.createMonitoredDeletionBatch.mockImplementation((...args) => {
    mocks.deletionBatch.mockImplementation(actual.createMonitoredDeletionBatch(...args));
    return mocks.deletionBatch;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startServer(): Promise<void> {
  await import('./index.ts');
  const assertStarted = (): void => {
    expect(mocks.logger.info).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 8080 },
      'server_started',
    );
  };
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    assertStarted();
  } else {
    await vi.waitFor(assertStarted);
  }
}

function signalServer(signal: 'SIGTERM' | 'SIGINT'): void {
  const handler = processOnSpy.mock.calls.find(([name]) => name === signal)?.[1];
  if (handler == null) throw new Error('MOCK missing signal handler');
  handler();
}

function respond(
  method: string,
  url: string,
  statusCode: number,
  authenticated = true,
): Promise<void> {
  const hook = mocks.app.addHook.mock.calls.find(([name]) => name === 'onResponse')?.[1] as
    ResponseHook | undefined;
  if (hook == null) throw new Error('MOCK missing onResponse hook');
  return new Promise<void>((resolve) => {
    hook(
      {
        method,
        routeOptions: { url },
        ...(authenticated
          ? {
              authenticatedUser: { id: 'MOCK user', identityStatus: 'active' },
              authenticatedAdmin: { id: 'MOCK admin', role: 'admin', email: 'MOCK email' },
            }
          : {}),
      },
      { statusCode },
      resolve,
    );
  });
}

async function useRealWorkers(): Promise<void> {
  const actual = await vi.importActual<typeof PeriodicWorkerModule>('./jobs/periodic-worker.ts');
  mocks.startPeriodicWorker.mockReset().mockImplementation(actual.startPeriodicWorker);
}

it('원장 전체 재이행 뒤 listen 전 두 워커와 응답 훅을 준비하고 삭제 전후 감시를 유지한다', async () => {
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
  expect(mocks.startPeriodicWorker).toHaveBeenCalledTimes(2);
  expect(mocks.app.addHook).toHaveBeenCalledWith('onResponse', expect.any(Function));
  expect(mocks.app.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8080 });
  expect(mocks.startPeriodicWorker.mock.invocationCallOrder[1]).toBeLessThan(
    mocks.app.listen.mock.invocationCallOrder[0]!,
  );
  expect(mocks.logger.info).not.toHaveBeenCalledWith(expect.anything(), 'server_started');
  listening.resolve('http://127.0.0.1:8080');
  await vi.waitFor(() =>
    expect(mocks.logger.info).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 8080 },
      'server_started',
    ),
  );

  expect(await mocks.startPeriodicWorker.mock.calls[0]![0]()).toBe(false);
  expect(await mocks.startPeriodicWorker.mock.calls[1]![0]()).toBe(false);
  expect(mocks.runPendingDeletionJobs).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.getDeletionQueueHealth).toHaveBeenCalledTimes(2);
  expect(mocks.deletionBatch).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.createMonitoredDeletionBatch.mock.calls[0]![2]).toBe(mocks.deletionAlerts);
  expect(mocks.createMonitoredDeletionBatch.mock.calls[0]![3]).toBeTypeOf('function');
  expect(mocks.createDeletionAlerts).toHaveBeenCalledExactlyOnceWith(
    'https://discord.com/api/webhooks/123/MOCK_TEST_ONLY',
    'dev',
    expect.any(Function),
  );
  expect(mocks.runPendingMasteryRecalcJobs).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.getMasteryQueuePending).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.getMasteryQueuePending.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.runPendingMasteryRecalcJobs.mock.invocationCallOrder[0]!,
  );
  expect(mocks.logger.info).toHaveBeenCalledWith({ enabled: true }, 'deletion_alerts_configured');
});

it.each(['build', 'replay'] as const)(
  '%s 실패 시 워커와 listen을 시작하지 않는다',
  async (stage) => {
    const steps = { build: mocks.buildApp, replay: mocks.replayDeletionJournal };
    steps[stage].mockRejectedValueOnce(new Error('MOCK sensitive connection information'));
    await import('./index.ts');
    await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(1));
    expect(mocks.startPeriodicWorker).not.toHaveBeenCalled();
    expect(mocks.createDeletionAlerts).not.toHaveBeenCalled();
    expect(mocks.logger.fatal).toHaveBeenCalledExactlyOnceWith('server_start_failed');
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.app.listen).not.toHaveBeenCalled();
    if (stage === 'build') expect(mocks.replayDeletionJournal).not.toHaveBeenCalled();
  },
);

it('listen 실패 시 이미 시작한 두 워커의 종료를 기다리고 오류 원문 없이 실패한다', async () => {
  const stopped = deferred<void>();
  mocks.stopDeletion.mockReturnValueOnce(stopped.promise);
  mocks.app.listen.mockRejectedValueOnce(new Error('MOCK sensitive listen failure'));
  await import('./index.ts');
  await vi.waitFor(() => expect(mocks.stopMastery).toHaveBeenCalledTimes(1));
  expect(mocks.stopDeletion).toHaveBeenCalledTimes(1);
  expect(processExitSpy).not.toHaveBeenCalled();
  expect(mocks.closeDb).not.toHaveBeenCalled();
  signalServer('SIGTERM');
  expect(mocks.app.close).toHaveBeenCalledTimes(1);
  stopped.resolve(undefined);
  await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(1));
  expect(mocks.logger.fatal).toHaveBeenCalledExactlyOnceWith('server_start_failed');
  expect(mocks.logger.error).not.toHaveBeenCalled();
});

it('삭제 성공 건수 대신 처리 후 실제 대기 건수로 재실행 여부를 결정한다', async () => {
  await startServer();
  const run = mocks.startPeriodicWorker.mock.calls[0]![0];
  mocks.runPendingDeletionJobs.mockResolvedValue(0);
  mocks.getDeletionQueueHealth.mockResolvedValue({ failed: 0, overdue: 0, pending: 1 });
  expect(await run()).toBe(true);
  mocks.runPendingDeletionJobs.mockResolvedValue(50);
  mocks.getDeletionQueueHealth.mockResolvedValue({ failed: 0, overdue: 0, pending: 0 });
  expect(await run()).toBe(false);
  expect(mocks.getDeletionQueueHealth).toHaveBeenCalledTimes(4);
});

it('대기 건수가 없는 구형 감시 콜백은 빈 큐라고 단정하지 않는다', async () => {
  await startServer();
  mocks.deletionBatch.mockImplementation(() => {
    mocks.createMonitoredDeletionBatch.mock.calls[0]![3]?.({ failed: 0, overdue: 0 });
    return Promise.resolve(0);
  });
  expect(await mocks.startPeriodicWorker.mock.calls[0]![0]()).toBe(true);
});

it('삭제 큐가 비어 있어도 미전송 알림이 남으면 빠른 재시도를 유지한다', async () => {
  await startServer();
  mocks.deletionAlerts.hasPendingDelivery.mockReturnValue(true);
  expect(await mocks.startPeriodicWorker.mock.calls[0]![0]()).toBe(true);
  mocks.deletionAlerts.hasPendingDelivery.mockReturnValue(false);
  expect(await mocks.startPeriodicWorker.mock.calls[0]![0]()).toBe(false);
});

it('숙련도 처리 후 대기 조회 결과를 그대로 워커에 전달한다', async () => {
  await startServer();
  mocks.getMasteryQueuePending.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const run = mocks.startPeriodicWorker.mock.calls[1]![0];
  expect(await run()).toBe(true);
  expect(await run()).toBe(false);
});

it.each([200, 202, 500, 503, 599])(
  '인증된 작업 생성 경로의 %s 응답만 해당 워커를 깨운다',
  async (status) => {
    await startServer();
    await respond('DELETE', '/v1/account', status);
    expect(mocks.stopDeletion.wake).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.stopMastery.wake).not.toHaveBeenCalled();
    await respond('PATCH', '/admin/v1/revisions/:id/status', status);
    expect(mocks.stopMastery.wake).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.stopDeletion.wake).toHaveBeenCalledTimes(1);
  },
);

it.each([400, 401, 403, 404, 409, 422, 429])(
  '%s 거절 응답은 워커를 깨우지 않는다',
  async (status) => {
    await startServer();
    await respond('DELETE', '/v1/account', status);
    await respond('PATCH', '/admin/v1/revisions/:id/status', status);
    expect(mocks.stopDeletion.wake).not.toHaveBeenCalled();
    expect(mocks.stopMastery.wake).not.toHaveBeenCalled();
  },
);

it('인증 컨텍스트가 없거나 메서드·라우트가 다른 응답은 깨우지 않는다', async () => {
  await startServer();
  await respond('DELETE', '/v1/account', 500, false);
  await respond('DELETE', '/v1/account', 503, false);
  await respond('PATCH', '/admin/v1/revisions/:id/status', 500, false);
  await respond('PATCH', '/admin/v1/revisions/:id/status', 503, false);
  await respond('GET', '/v1/account', 200);
  await respond('DELETE', '/v1/account/deletion/:jobId', 200);
  await respond('PATCH', '/admin/v1/question-revisions/:id/status', 200);
  await respond('GET', '/health', 200, false);
  await respond('POST', '/v1/study/today', 200);
  expect(mocks.stopDeletion.wake).not.toHaveBeenCalled();
  expect(mocks.stopMastery.wake).not.toHaveBeenCalled();
});

it('Fastify에 먼저 등록한 루트와 관리자 하위 scope에도 응답 깨우기 훅이 적용된다', async () => {
  const app = Fastify();
  app.delete(
    '/v1/account',
    {
      preHandler: (request, _reply, done) => {
        if (request.headers['x-mock-authenticated'] !== 'false') {
          request.authenticatedUser = { id: 'MOCK user', identityStatus: 'active' };
        }
        done();
      },
    },
    (request, reply) => reply.code(Number(request.headers['x-mock-status'] ?? 202)).send({}),
  );
  app.get('/health', () => ({ status: 'ok' }));
  await app.register(
    (scope, _options, done) => {
      scope.patch(
        '/revisions/:id/status',
        {
          preHandler: (request, _reply, next) => {
            if (request.headers['x-mock-authenticated'] !== 'false') {
              request.authenticatedAdmin = { id: 'MOCK admin', role: 'admin', email: 'MOCK email' };
            }
            next();
          },
        },
        (request, reply) => reply.code(Number(request.headers['x-mock-status'] ?? 200)).send({}),
      );
      done();
    },
    { prefix: '/admin/v1' },
  );
  mocks.buildApp.mockResolvedValueOnce(app as unknown as typeof mocks.app);
  const listeningApp: { listen: (options: FastifyListenOptions) => Promise<string> } = app;
  vi.spyOn(listeningApp, 'listen').mockImplementation(async () => {
    await app.ready();
    return 'http://127.0.0.1:8080';
  });

  try {
    await startServer();
    for (const status of [202, 500, 503]) {
      mocks.stopDeletion.wake.mockClear();
      mocks.stopMastery.wake.mockClear();
      const deletion = await app.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: { 'x-mock-status': String(status) },
      });
      expect(deletion.statusCode).toBe(status);
      expect(mocks.stopDeletion.wake).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.stopMastery.wake).not.toHaveBeenCalled();
      const mastery = await app.inject({
        method: 'PATCH',
        url: '/admin/v1/revisions/MOCK-revision/status',
        headers: { 'x-mock-status': String(status) },
      });
      expect(mastery.statusCode).toBe(status);
      expect(mocks.stopMastery.wake).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.stopDeletion.wake).toHaveBeenCalledTimes(1);
    }
    mocks.stopDeletion.wake.mockClear();
    mocks.stopMastery.wake.mockClear();
    for (const [method, url] of [
      ['DELETE', '/v1/account'],
      ['PATCH', '/admin/v1/revisions/MOCK-revision/status'],
    ] as const) {
      const limited = await app.inject({ method, url, headers: { 'x-mock-status': '429' } });
      expect(limited.statusCode).toBe(429);
      const unauthenticated = await app.inject({
        method,
        url,
        headers: { 'x-mock-status': '503', 'x-mock-authenticated': 'false' },
      });
      expect(unauthenticated.statusCode).toBe(503);
    }
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect(mocks.stopDeletion.wake).not.toHaveBeenCalled();
    expect(mocks.stopMastery.wake).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('숙련도·삭제 워커와 전송 실패는 오류 원문 없이 코드만 기록한다', async () => {
  await startServer();
  await mocks.startPeriodicWorker.mock.calls[1]![1]();
  await mocks.startPeriodicWorker.mock.calls[0]![1]();
  mocks.createDeletionAlerts.mock.calls[0]![2]();
  expect(mocks.logger.error.mock.calls).toEqual([
    ['mastery_recalc_worker_failed'],
    ['deletion_worker_failed'],
    ['deletion_alert_delivery_failed'],
  ]);
});

it('실제 워커는 유휴 15분 동안 DB 작업 없이 기다리고 교차 프로세스 작업을 다시 조회한다', async () => {
  vi.useFakeTimers();
  await useRealWorkers();
  const startedAt = Date.now();
  await startServer();
  expect(Date.now()).toBe(startedAt);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.runPendingDeletionJobs).toHaveBeenCalledTimes(1);
  expect(mocks.getDeletionQueueHealth).toHaveBeenCalledTimes(2);
  expect(mocks.runPendingMasteryRecalcJobs).toHaveBeenCalledTimes(1);
  expect(mocks.getMasteryQueuePending).toHaveBeenCalledTimes(1);
  await respond('GET', '/health', 200, false);
  await respond('POST', '/v1/study/today', 200);
  await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
  expect(mocks.runPendingDeletionJobs).toHaveBeenCalledTimes(1);
  expect(mocks.getDeletionQueueHealth).toHaveBeenCalledTimes(2);
  expect(mocks.runPendingMasteryRecalcJobs).toHaveBeenCalledTimes(1);
  expect(mocks.getMasteryQueuePending).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.runPendingDeletionJobs).toHaveBeenCalledTimes(2);
  expect(mocks.getDeletionQueueHealth).toHaveBeenCalledTimes(4);
  expect(mocks.runPendingMasteryRecalcJobs).toHaveBeenCalledTimes(2);
  signalServer('SIGTERM');
  await vi.advanceTimersByTimeAsync(0);
  expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(0);
});

it.each([500, 503])(
  '원장 intent만 남길 수 있는 인증 후 %s 응답은 유휴 삭제 배치를 즉시 재실행한다',
  async (status) => {
    vi.useFakeTimers();
    await useRealWorkers();
    await startServer();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runPendingDeletionJobs).toHaveBeenCalledTimes(1);
    await respond('DELETE', '/v1/account', status);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runPendingDeletionJobs).toHaveBeenCalledTimes(2);
    expect(mocks.runPendingMasteryRecalcJobs).toHaveBeenCalledTimes(1);
    signalServer('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
  },
);

it('삭제 복구 후 알림 전송 실패도 5분에 재시도하고 전달 성공 뒤에는 유휴로 전환한다', async () => {
  vi.useFakeTimers();
  await useRealWorkers();
  const actual = await vi.importActual<typeof DeletionAlertsModule>('./jobs/deletion-alerts.ts');
  const send = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('MOCK private webhook failure'))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  mocks.createDeletionAlerts.mockImplementation((url, environment, onError) =>
    actual.createDeletionAlerts(url, environment, onError, send),
  );
  mocks.getDeletionQueueHealth.mockResolvedValueOnce({ failed: 1, overdue: 0, pending: 1 });
  const startedAt = Date.now();
  await startServer();
  expect(Date.now()).toBe(startedAt);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]![1]!.body).toContain('정상화');
  const inspected = mocks.getDeletionQueueHealth.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.getDeletionQueueHealth).toHaveBeenCalledTimes(inspected);
  signalServer('SIGTERM');
  await vi.advanceTimersByTimeAsync(0);
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
    await respond('DELETE', '/v1/account', 202);
    expect(mocks.stopDeletion.wake).not.toHaveBeenCalled();

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

it('원장 재이행 중 종료는 재이행을 기다리고 워커나 listen을 시작하지 않는다', async () => {
  const replay = deferred<void>();
  mocks.replayDeletionJournal.mockReturnValueOnce(replay.promise);
  await import('./index.ts');
  await vi.waitFor(() => expect(mocks.replayDeletionJournal).toHaveBeenCalledTimes(1));
  signalServer('SIGTERM');
  signalServer('SIGINT');
  expect(mocks.app.close).not.toHaveBeenCalled();
  expect(mocks.closeDb).not.toHaveBeenCalled();
  replay.resolve(undefined);
  await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(0));
  expect(mocks.app.close).toHaveBeenCalledTimes(1);
  expect(mocks.app.listen).not.toHaveBeenCalled();
  expect(mocks.startPeriodicWorker).not.toHaveBeenCalled();
  expect(mocks.logger.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'shutdown_started');
  expect(mocks.logger.info).not.toHaveBeenCalledWith({ signal: 'SIGINT' }, 'shutdown_started');
});

it('listen 대기 중 종료는 시작 완료를 기다리고 중복 종료와 뒤늦은 시작 로그를 막는다', async () => {
  const listening = deferred<string>();
  mocks.app.listen.mockReturnValueOnce(listening.promise);
  await import('./index.ts');
  await vi.waitFor(() => expect(mocks.app.listen).toHaveBeenCalledTimes(1));
  signalServer('SIGINT');
  signalServer('SIGTERM');
  expect(mocks.closeDb).not.toHaveBeenCalled();
  expect(mocks.app.close).not.toHaveBeenCalled();
  listening.resolve('http://127.0.0.1:8080');
  await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(0));
  expect(mocks.stopDeletion).toHaveBeenCalledTimes(1);
  expect(mocks.stopMastery).toHaveBeenCalledTimes(1);
  expect(mocks.app.close).toHaveBeenCalledTimes(1);
  expect(mocks.logger.info).not.toHaveBeenCalledWith(expect.anything(), 'server_started');
});

it('워커 종료 실패 시 DB를 닫지 않고 오류 원문 없이 종료 실패를 기록한다', async () => {
  await startServer();
  mocks.stopMastery.mockRejectedValueOnce(new Error('MOCK worker stop failure'));
  signalServer('SIGTERM');
  await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(1));
  expect(mocks.stopDeletion).toHaveBeenCalledTimes(1);
  expect(mocks.stopMastery).toHaveBeenCalledTimes(1);
  expect(mocks.closeDb).not.toHaveBeenCalled();
  expect(mocks.closeDeletionJournal).not.toHaveBeenCalled();
  expect(mocks.logger.error).toHaveBeenCalledExactlyOnceWith('shutdown_failed');
});
