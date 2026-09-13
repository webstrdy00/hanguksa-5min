import { afterEach, expect, it, vi } from 'vitest';
import { startDeletionWorker } from './deletion-worker.ts';

afterEach(() => vi.useRealTimers());

it('기동 시 실행하고 이전 배치 종료 후에만 다음 배치를 시작한다', async () => {
  vi.useFakeTimers();
  let finish!: (value: number) => void;
  const run = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startDeletionWorker(run, vi.fn());
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(run).toHaveBeenCalledTimes(1);
  finish(1);
  await vi.advanceTimersByTimeAsync(30_000);
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
  const stop = startDeletionWorker(run, onError);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(2);
  await stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
});
