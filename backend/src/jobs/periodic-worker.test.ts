import { afterEach, expect, it, vi } from 'vitest';
import { startPeriodicWorker } from './periodic-worker.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('기동 시 실행하고 이전 배치 종료 후에만 다음 배치를 시작한다', async () => {
  vi.useFakeTimers();
  let finish!: (value: number) => void;
  const run = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startPeriodicWorker(run, vi.fn());
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(run).toHaveBeenCalledTimes(1);
  finish(1);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  let closed = false;
  const closing = stop().then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(closed).toBe(false);
  finish(0);
  await closing;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('DB 실패를 알리고 다음 주기에 재시도하며 종료 후 멈춘다', async () => {
  vi.useFakeTimers();
  const run = vi.fn().mockRejectedValueOnce(new Error('MOCK database down')).mockResolvedValue(0);
  const onError = vi.fn();
  const stop = startPeriodicWorker(run, onError);
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledExactlyOnceWith();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('삭제 배치가 끝나지 않아도 숙련도 배치는 독립 실행하고 종료한다', async () => {
  vi.useFakeTimers();
  let finishDeletion!: (value: number) => void;
  const deletion = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finishDeletion = resolve;
      }),
  );
  const mastery = vi.fn().mockResolvedValue([{ jobId: 'MOCK mastery job' }]);
  const stopDeletion = startPeriodicWorker(deletion, vi.fn());
  const stopMastery = startPeriodicWorker(mastery, vi.fn());
  expect(deletion).toHaveBeenCalledTimes(1);
  expect(mastery).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(deletion).toHaveBeenCalledTimes(1);
  expect(mastery).toHaveBeenCalledTimes(4);

  const closingDeletion = stopDeletion();
  finishDeletion(0);
  await closingDeletion;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deletion).toHaveBeenCalledTimes(1);
  expect(mastery).toHaveBeenCalledTimes(5);
  await stopMastery();
  expect(vi.getTimerCount()).toBe(0);
});

it('다음 배치 타이머만으로 서버 프로세스를 유지하지 않는다', async () => {
  vi.useFakeTimers();
  const schedule = vi.spyOn(globalThis, 'setTimeout');
  const stop = startPeriodicWorker(() => Promise.resolve([]), vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 30_000);
  const timer = schedule.mock.results[0]!.value as ReturnType<typeof setTimeout>;
  expect(timer.hasRef()).toBe(false);
  await stop();
  expect(vi.getTimerCount()).toBe(0);
});
