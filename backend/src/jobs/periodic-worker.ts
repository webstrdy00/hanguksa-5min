const BUSY_DELAY_MS = 30_000;
const RECONCILIATION_DELAY_MS = 15 * 60_000;

/**
 * true는 남은 작업, false는 성공적으로 확인한 유휴 상태를 뜻한다.
 * 유휴 시에도 다른 프로세스의 쓰기나 원장/주 DB 간 실패를 대조하기 위해 15분마다 확인한다.
 * 이 보수적 대조 주기는 유휴 DB 요청 제거나 무료 quota 보장을 뜻하지 않는다.
 * 중첩 실행을 피하고 종료 시 진행 중인 트랜잭션을 기다린다.
 */
export function startPeriodicWorker(
  run: () => Promise<boolean>,
  onError: () => void | Promise<void>,
): (() => Promise<void>) & { wake: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let wakeRequested = false;
  let retryDelay = BUSY_DELAY_MS;
  let backingOff = false;

  const schedule = (delay: number): void => {
    timer = setTimeout(tick, delay);
    timer.unref();
  };

  const runBatch = async (finish: () => void): Promise<void> => {
    let delay = RECONCILIATION_DELAY_MS;
    try {
      const pending = await run();
      backingOff = false;
      retryDelay = BUSY_DELAY_MS;
      delay = pending ? BUSY_DELAY_MS : RECONCILIATION_DELAY_MS;
    } catch {
      backingOff = true;
      delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, RECONCILIATION_DELAY_MS);
      try {
        await Promise.resolve(onError());
      } catch {
        // 오류 보고 실패도 다음 재시도를 막거나 미처리 rejection을 만들지 않는다.
      }
    } finally {
      inFlight = undefined;
      if (!stopped) {
        // 실패 중 들어온 신호는 예약된 재시도에 병합한다. 백오프를 앞당기지 않는다.
        schedule(wakeRequested && !backingOff ? 0 : delay);
        wakeRequested = false;
      }
      finish();
    }
  };

  const tick = (): void => {
    if (stopped || inFlight) return;
    timer = undefined;
    let finish!: () => void;
    // run이 동기적으로 stop/wake를 호출해도 현재 배치를 기다리도록 먼저 등록한다.
    inFlight = new Promise<void>((resolve) => {
      finish = resolve;
    });
    void runBatch(finish);
  };

  const stop = (): Promise<void> => {
    stopped = true;
    wakeRequested = false;
    clearTimeout(timer);
    timer = undefined;
    return inFlight ?? Promise.resolve();
  };
  stop.wake = (): void => {
    if (stopped) return;
    if (inFlight) {
      wakeRequested = true;
      return;
    }
    // 재시도 타이머는 이미 한 배치를 보장한다. 새 신호로 취소하거나 연장하지 않는다.
    if (backingOff) return;
    clearTimeout(timer);
    tick();
  };

  tick();
  return stop;
}
