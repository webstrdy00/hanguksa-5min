import { afterEach, expect, it, vi } from 'vitest';
import { createDeletionAlerts, createMonitoredDeletionBatch } from './deletion-alerts.ts';

afterEach(() => vi.useRealTimers());
const url = 'https://discord.com/api/webhooks/123/MOCK_TEST_ONLY';
const unhealthy = { failed: 1, overdue: 2, unavailable: false };
const healthy = { failed: 0, overdue: 0, unavailable: false };

it('비활성 및 정상 상태에는 외부 요청을 보내지 않는다', async () => {
  const send = vi.fn<typeof fetch>();
  const disabled = createDeletionAlerts(undefined, 'dev', vi.fn(), send);
  const enabled = createDeletionAlerts(url, 'production', vi.fn(), send);
  await disabled(unhealthy);
  await enabled(healthy);
  expect(send).not.toHaveBeenCalled();
  expect(disabled.hasPendingDelivery()).toBe(false);
  expect(enabled.hasPendingDelivery()).toBe(false);
});

it('개인정보 없이 건수만 보내고 지속 장애 30분 제한과 정상화를 처리한다', async () => {
  let now = 0;
  const send = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
  const notify = createDeletionAlerts(url, 'production', vi.fn(), send, () => now);
  await notify(unhealthy);
  const options = send.mock.calls[0]![1]!;
  if (typeof options.body !== 'string') throw new Error('Expected JSON string');
  const body = JSON.parse(options.body) as {
    content: string;
    allowed_mentions: { parse: string[] };
  };
  expect(body.content).toContain('실패 작업: 1건');
  expect(body.content).toContain('15분 이상 미완료: 2건');
  expect(body.allowed_mentions.parse).toEqual([]);
  expect(options.redirect).toBe('error');
  expect(options.signal).toBeInstanceOf(AbortSignal);
  now = 30 * 60_000 - 1;
  await notify(unhealthy);
  expect(send).toHaveBeenCalledTimes(1);
  now++;
  await notify(unhealthy);
  expect(send).toHaveBeenCalledTimes(2);
  await notify(healthy);
  expect(send.mock.calls[2]![1]!.body).toContain('정상화');
  await notify(healthy);
  expect(send).toHaveBeenCalledTimes(3);
});

it.each([429, 503])('%s 전송 실패는 원문 없이 보고하고 5분 뒤 재시도한다', async (status) => {
  let now = 0;
  const onError = vi.fn();
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('MOCK sensitive error', { status }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const notify = createDeletionAlerts(url, 'production', onError, send, () => now);
  await notify(unhealthy);
  expect(onError).toHaveBeenCalledWith();
  expect(notify.hasPendingDelivery()).toBe(true);
  now = 5 * 60_000 - 1;
  await notify(unhealthy);
  expect(send).toHaveBeenCalledTimes(1);
  now++;
  await notify(unhealthy);
  expect(send).toHaveBeenCalledTimes(2);
  expect(notify.hasPendingDelivery()).toBe(false);
});

it('중단 신호를 사용하는 네트워크 오류를 외부로 던지지 않는다', async () => {
  const onError = vi.fn();
  const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('MOCK secret URL'));
  await expect(
    createDeletionAlerts(url, 'production', onError, send)(unhealthy),
  ).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledWith();
});

it('처리 전 장기 대기와 처리 후 복구를 감시한다', async () => {
  const inspect = vi
    .fn()
    .mockResolvedValueOnce({ failed: 0, overdue: 1 })
    .mockResolvedValueOnce(healthy);
  const run = vi.fn().mockResolvedValue(1);
  const notify = vi.fn().mockResolvedValue(undefined);
  expect(await createMonitoredDeletionBatch(run, inspect, notify)()).toBe(1);
  expect(notify.mock.calls).toEqual([[{ failed: 0, overdue: 1, unavailable: false }], [healthy]]);
});

it('배치 중 발생한 실패를 처리 후 알린다', async () => {
  const inspect = vi.fn().mockResolvedValueOnce(healthy).mockResolvedValueOnce(unhealthy);
  const notify = vi.fn().mockResolvedValue(undefined);
  await createMonitoredDeletionBatch(() => Promise.resolve(0), inspect, notify)();
  expect(notify).toHaveBeenCalledExactlyOnceWith(unhealthy);
});

it('DB 조회 실패는 관측 불가 알림을 보내고 워커 재시도 경로에 전달한다', async () => {
  const error = new Error('MOCK database down');
  const inspect = vi.fn().mockRejectedValue(error);
  const notify = vi.fn().mockResolvedValue(undefined);
  const run = vi.fn();
  await expect(createMonitoredDeletionBatch(run, inspect, notify)()).rejects.toBe(error);
  expect(run).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith({ ...healthy, unavailable: true });
});

it('Discord 장애가 실제 삭제 실행을 막지 않는다', async () => {
  const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('MOCK network down'));
  const inspect = vi.fn().mockResolvedValue(unhealthy);
  const run = vi.fn().mockResolvedValue(2);
  const notify = createDeletionAlerts(url, 'production', vi.fn(), send);
  expect(await createMonitoredDeletionBatch(run, inspect, notify)()).toBe(2);
  expect(run).toHaveBeenCalledTimes(1);
});

it('최초 알림 전송 실패 후 큐가 정상화되어도 미전송 사실을 다시 보고한다', async () => {
  let now = 0;
  const send = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('MOCK network down'))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const notify = createDeletionAlerts(url, 'production', vi.fn(), send, () => now);
  await notify(unhealthy);
  expect(notify.hasPendingDelivery()).toBe(true);
  await notify(healthy);
  expect(notify.hasPendingDelivery()).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  now = 5 * 60_000;
  await notify(healthy);
  expect(send).toHaveBeenCalledTimes(2);
  expect(notify.hasPendingDelivery()).toBe(false);
  expect(send.mock.calls[1]![1]!.body).toContain('정상화');
  expect(send.mock.calls[1]![1]!.body).toContain('이전 알림 전송 실패');
  await notify(healthy);
  expect(send).toHaveBeenCalledTimes(2);
});

it('정상화 알림 실패 후 장애가 다시 생겨도 30분 제한보다 5분 전송 재시도가 우선한다', async () => {
  let now = 0;
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockRejectedValueOnce(new Error('MOCK recovery delivery failure'))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const notify = createDeletionAlerts(url, 'production', vi.fn(), send, () => now);
  await notify(unhealthy);
  now = 30_000;
  await notify(healthy);
  expect(notify.hasPendingDelivery()).toBe(true);
  now += 5 * 60_000 - 1;
  await notify(unhealthy);
  expect(send).toHaveBeenCalledTimes(2);
  now++;
  await notify(unhealthy);
  expect(send).toHaveBeenCalledTimes(3);
  expect(notify.hasPendingDelivery()).toBe(false);
  expect(send.mock.calls[2]![1]!.body).toContain('이전 알림 전송 실패');
});

it('숫자 반환 계약과 전후 조회를 유지하며 처리 후 대기 건수를 추가 조회 없이 관찰한다', async () => {
  const before = { failed: 0, overdue: 0, pending: 50 };
  const after = { failed: 0, overdue: 0, pending: 1 };
  const inspect = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  const run = vi.fn().mockResolvedValue(0);
  const notify = vi.fn().mockResolvedValue(undefined);
  const onHealth = vi.fn();
  const batch = createMonitoredDeletionBatch(run, inspect, notify, onHealth);
  expect(await batch()).toBe(0);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(onHealth).toHaveBeenCalledExactlyOnceWith(after);
  expect(onHealth.mock.invocationCallOrder[0]).toBeGreaterThan(run.mock.invocationCallOrder[0]!);
  expect(notify).toHaveBeenCalledExactlyOnceWith({ ...after, unavailable: false });
});

it('처리 후 큐 조회 실패는 정상 관측을 알리지 않고 기존 재시도 경로로 전달한다', async () => {
  const error = new Error('MOCK post-batch database failure');
  const inspect = vi.fn().mockResolvedValueOnce(healthy).mockRejectedValueOnce(error);
  const notify = vi.fn().mockResolvedValue(undefined);
  const onHealth = vi.fn();
  const batch = createMonitoredDeletionBatch(() => Promise.resolve(1), inspect, notify, onHealth);
  await expect(batch()).rejects.toBe(error);
  expect(onHealth).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledExactlyOnceWith({ ...healthy, unavailable: true });
});
