/**
 * 서버 기동 시 및 이전 배치 종료 30초 후 삭제 큐를 처리한다.
 * 중첩 실행을 피하고 종료 시 진행 중인 트랜잭션을 기다린다.
 * 외부 ping 으로 무료 서버의 절전을 우회하지 않는다.
 */
export function startDeletionWorker(
  run: () => Promise<number>,
  onError: () => void,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void>;

  const tick = async (): Promise<void> => {
    try {
      await run();
    } catch {
      onError();
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          inFlight = tick();
        }, 30_000);
        timer.unref();
      }
    }
  };

  inFlight = tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await inFlight;
  };
}
