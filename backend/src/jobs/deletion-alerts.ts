type QueueHealth = { failed: number; overdue: number };
type AlertState = QueueHealth & { unavailable: boolean };

/**
 * 건수만 전송한다. 사용자/작업 ID, 오류 원문, 웹훅은 메시지와 로그에 넣지 않는다.
 * 중복 제한은 단일 프로세스 메모리 기준이며 재시작하면 초기화된다.
 */
export function createDeletionAlerts(
  webhookUrl: string | undefined,
  environment: 'dev' | 'staging' | 'production',
  onDeliveryFailure: () => void,
  send: typeof fetch = fetch,
  clock: () => number = Date.now,
): (state: AlertState) => Promise<void> {
  let active = false;
  let lastSent = -Infinity;
  let retryAfter = -Infinity;

  return async (state) => {
    if (webhookUrl == null) return;
    const now = clock();
    const unhealthy = state.unavailable || state.failed > 0 || state.overdue > 0;
    if (now < retryAfter || (!unhealthy && !active)) return;
    if (unhealthy && active && now - lastSent < 30 * 60_000) return;

    const content = [
      `[한능검 5분 / ${environment}] ${unhealthy ? '삭제 작업 확인 필요' : '삭제 작업 정상화'}`,
      state.unavailable
        ? '삭제 배치 또는 큐 조회 실패. 서버 로그를 확인해주세요.'
        : `실패 작업: ${state.failed}건 / 요청 후 15분 이상 미완료: ${state.overdue}건`,
      '백업 소거 완료 여부는 별도입니다.',
    ].join('\n');

    try {
      const response = await send(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Discord delivery failed');
      active = unhealthy;
      lastSent = now;
      retryAfter = -Infinity;
    } catch {
      retryAfter = now + 5 * 60_000;
      onDeliveryFailure();
    }
  };
}

/** 처리 전 장기 대기와 처리 후 실패를 확인하며 전송 장애가 삭제를 막지 않는다. */
export function createMonitoredDeletionBatch(
  run: () => Promise<number>,
  inspect: () => Promise<QueueHealth>,
  notify: (state: AlertState) => Promise<void>,
): () => Promise<number> {
  return async () => {
    try {
      const before = await inspect();
      if (before.failed > 0 || before.overdue > 0) {
        await notify({ ...before, unavailable: false });
      }
      const processed = await run();
      await notify({ ...(await inspect()), unavailable: false });
      return processed;
    } catch (error) {
      await notify({ failed: 0, overdue: 0, unavailable: true });
      throw error;
    }
  };
}
