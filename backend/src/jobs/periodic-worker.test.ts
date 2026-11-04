import { afterEach, expect, it, vi } from 'vitest';
import { startPeriodicWorker } from './periodic-worker.ts';

function deferredBatch() {
  let resolve!: (pending: boolean) => void;
  const promise = new Promise<boolean>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('기동 시 실행하고 이전 배치 종료 후에만 다음 배치를 시작한다', async () => {
  vi.useFakeTimers();
  const first = deferredBatch();
  const second = deferredBatch();
  const run = vi
    .fn<() => Promise<boolean>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValue(second.promise);
  const stop = startPeriodicWorker(run, vi.fn());
  expect(run).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(run).toHaveBeenCalledTimes(1);
  first.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(run).toHaveBeenCalledTimes(2);
  const closing = stop();
  second.resolve(false);
  await closing;
  expect(vi.getTimerCount()).toBe(0);
});

it('성공적으로 유휴를 확인하면 다른 프로세스·원장 대조를 15분 간격으로 유지한다', async () => {
  vi.useFakeTimers();
  const run = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
  const stop = startPeriodicWorker(run, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(899_999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(900_000);
  expect(run).toHaveBeenCalledTimes(3);
  await stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('알려진 작업이 남으면 30초 간격으로 처리한다', async () => {
  vi.useFakeTimers();
  const run = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const stop = startPeriodicWorker(run, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(3);
  await stop();
});

it('유휴 중 wake는 기존 타이머를 취소하고 즉시 배치를 시작한다', async () => {
  vi.useFakeTimers();
  const run = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
  const stop = startPeriodicWorker(run, vi.fn());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(run).toHaveBeenCalledTimes(1);
  stop.wake();
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(899_999);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(3);
  await stop();
});

it('실행 중 wake와 완료 직전 wake는 재귀 호출 없이 다음 한 배치로 합친다', async () => {
  vi.useFakeTimers();
  const schedule = vi.spyOn(globalThis, 'setTimeout');
  const first = deferredBatch();
  const second = deferredBatch();
  const run = vi
    .fn<() => Promise<boolean>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(false);
  const stop = startPeriodicWorker(run, vi.fn());
  stop.wake();
  stop.wake();
  await vi.advanceTimersByTimeAsync(900_000);
  expect(run).toHaveBeenCalledTimes(1);
  first.resolve(false);
  stop.wake();
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(1);
  expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 0);
  const timer = schedule.mock.results[0]!.value as ReturnType<typeof setTimeout>;
  expect(timer.hasRef()).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  second.resolve(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(899_999);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(3);
  await stop();
});

it('완료 후 예약된 wake 타이머 직전의 wake도 한 배치만 시작한다', async () => {
  vi.useFakeTimers();
  const first = deferredBatch();
  const second = deferredBatch();
  const run = vi
    .fn<() => Promise<boolean>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValue(second.promise);
  const stop = startPeriodicWorker(run, vi.fn());
  stop.wake();
  first.resolve(false);
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(1);
  stop.wake();
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  const closing = stop();
  second.resolve(false);
  await closing;
});

it('기동 직후 stop은 실행 중 배치를 기다리고 예약된 wake와 이후 wake를 무시한다', async () => {
  vi.useFakeTimers();
  const first = deferredBatch();
  const run = vi.fn<() => Promise<boolean>>().mockReturnValue(first.promise);
  const stop = startPeriodicWorker(run, vi.fn());
  stop.wake();
  stop.wake();
  let closed = false;
  const closing = stop().then(() => {
    closed = true;
  });
  const closingAgain = stop();
  stop.wake();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(closed).toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
  first.resolve(true);
  await Promise.all([closing, closingAgain]);
  expect(closed).toBe(true);
  await stop();
  stop.wake();
  await vi.advanceTimersByTimeAsync(1_800_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('배치가 동기적으로 wake와 stop을 호출해도 현재 배치를 끝까지 기다린다', async () => {
  vi.useFakeTimers();
  const second = deferredBatch();
  let closing!: Promise<void>;
  let closed = false;
  const run = vi
    .fn<() => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(() => {
      stop.wake();
      closing = stop().then(() => {
        closed = true;
      });
      return second.promise;
    });
  const stop = startPeriodicWorker(run, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  stop.wake();
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toBe(false);
  second.resolve(true);
  await closing;
  expect(closed).toBe(true);
  stop.wake();
  await vi.advanceTimersByTimeAsync(1_800_000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('비동기 wake가 실행되기 전에 stop하면 예약된 배치를 시작하지 않는다', async () => {
  vi.useFakeTimers();
  const first = deferredBatch();
  const run = vi.fn<() => Promise<boolean>>().mockReturnValue(first.promise);
  const stop = startPeriodicWorker(run, vi.fn());
  stop.wake();
  first.resolve(false);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(1);
  await stop();
  await vi.advanceTimersByTimeAsync(1_800_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('미확인 실패는 30초부터 지수 백오프하고 15분 상한을 유지한다', async () => {
  vi.useFakeTimers();
  const run = vi.fn<() => Promise<boolean>>().mockRejectedValue(new Error('MOCK database down'));
  const onError = vi.fn();
  const stop = startPeriodicWorker(run, onError);
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledExactlyOnceWith();
  for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    const attempts = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(run).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(attempts + 1);
    expect(onError).toHaveBeenCalledTimes(attempts + 1);
    expect(vi.getTimerCount()).toBe(1);
  }
  await stop();
  await vi.advanceTimersByTimeAsync(1_800_000);
  expect(run).toHaveBeenCalledTimes(8);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])(
  '성공한 배치(%s)는 다음 실패의 백오프를 30초로 초기화한다',
  async (pending) => {
    vi.useFakeTimers();
    const failure = new Error('MOCK database down');
    const run = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(pending)
      .mockRejectedValue(failure);
    const stop = startPeriodicWorker(run, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(pending ? 30_000 : 900_000);
    expect(run).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(5);
    await stop();
  },
);

it('실패 대기 중 반복 wake도 지수 백오프를 앞당기거나 연장하지 않는다', async () => {
  vi.useFakeTimers();
  const run = vi.fn<() => Promise<boolean>>().mockRejectedValue(new Error('MOCK outage'));
  const stop = startPeriodicWorker(run, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000]) {
    const attempts = run.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      stop.wake();
      await vi.advanceTimersByTimeAsync(delay / 3 - (i === 2 ? 1 : 0));
      expect(run).toHaveBeenCalledTimes(attempts);
      expect(vi.getTimerCount()).toBe(1);
    }
    stop.wake();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(attempts + 1);
  }
  await stop();
  stop.wake();
  await vi.advanceTimersByTimeAsync(900_000);
  expect(run).toHaveBeenCalledTimes(7);
  expect(vi.getTimerCount()).toBe(0);
});

it('실패 직전과 오류 보고 중 wake를 재시도에 병합하고 성공 후 즉시 wake를 복원한다', async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const first = new Promise<boolean>((_resolve, fail) => {
    reject = fail;
  });
  const reporting = deferredBatch();
  const run = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(first).mockResolvedValue(false);
  const stop = startPeriodicWorker(run, () => reporting.promise.then(() => undefined));
  stop.wake();
  reject(new Error('MOCK outage'));
  await vi.advanceTimersByTimeAsync(0);
  stop.wake();
  reporting.resolve(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(29_999);
  stop.wake();
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  stop.wake();
  expect(run).toHaveBeenCalledTimes(3);
  await stop();
});

it('동기적으로 실패한 배치도 보고하고 재시도한다', async () => {
  vi.useFakeTimers();
  const run = vi
    .fn<() => Promise<boolean>>()
    .mockImplementationOnce(() => {
      throw new Error('MOCK synchronous database failure');
    })
    .mockResolvedValue(false);
  const onError = vi.fn();
  const stop = startPeriodicWorker(run, onError);
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledExactlyOnceWith();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(2);
  await stop();
});

it.each(['throw', 'reject'])(
  '오류 보고가 %s해도 미처리 rejection 없이 재시도한다',
  async (failure) => {
    vi.useFakeTimers();
    const run = vi.fn<() => Promise<boolean>>().mockRejectedValue(new Error('MOCK database down'));
    const onError = vi.fn<() => void | Promise<void>>(() => {
      const error = new Error('MOCK error reporter down');
      if (failure === 'throw') throw error;
      return Promise.reject<void>(error);
    });
    const stop = startPeriodicWorker(run, onError);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    await stop();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('삭제 배치가 끝나지 않아도 숙련도 배치는 독립 실행하고 종료한다', async () => {
  vi.useFakeTimers();
  const batch = deferredBatch();
  const deletion = vi.fn<() => Promise<boolean>>().mockReturnValue(batch.promise);
  const mastery = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const stopDeletion = startPeriodicWorker(deletion, vi.fn());
  const stopMastery = startPeriodicWorker(mastery, vi.fn());
  expect(deletion).toHaveBeenCalledTimes(1);
  expect(mastery).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(deletion).toHaveBeenCalledTimes(1);
  expect(mastery).toHaveBeenCalledTimes(4);

  const closingDeletion = stopDeletion();
  batch.resolve(false);
  await closingDeletion;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deletion).toHaveBeenCalledTimes(1);
  expect(mastery).toHaveBeenCalledTimes(5);
  await stopMastery();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { state: 'pending', outcome: true, delay: 30_000 },
  { state: 'idle', outcome: false, delay: 900_000 },
  { state: 'failed', outcome: new Error('MOCK database down'), delay: 30_000 },
])('$state 타이머만으로 서버 프로세스를 유지하지 않는다', async ({ outcome, delay }) => {
  vi.useFakeTimers();
  const schedule = vi.spyOn(globalThis, 'setTimeout');
  const run = () => (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome));
  const stop = startPeriodicWorker(run, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), delay);
  const timer = schedule.mock.results[0]!.value as ReturnType<typeof setTimeout>;
  expect(timer.hasRef()).toBe(false);
  await stop();
  expect(vi.getTimerCount()).toBe(0);
});
