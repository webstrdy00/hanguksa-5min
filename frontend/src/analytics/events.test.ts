import { beforeEach, expect, it, vi } from 'vitest';
import { ANALYTICS_EVENTS, trackComplete } from './events.ts';

const { log } = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('@apps-in-toss/web-framework', () => ({ Analytics: { log } }));

beforeEach(() => {
  log.mockReset().mockResolvedValue(undefined);
});

it.each([
  ['daily_study', 'complete_daily_study'],
  ['review', 'complete_review'],
  ['notification_agreed', 'complete_notification_agreed'],
])('완료 이벤트 %s의 실제 전송 이름과 콘솔 전환 목록이 일치한다', async (eventName, logName) => {
  await trackComplete(eventName);
  expect(log).toHaveBeenCalledExactlyOnceWith({
    log_name: logName,
    log_type: 'event',
    params: {},
  });
  expect([ANALYTICS_EVENTS.conversion, ...ANALYTICS_EVENTS.secondary]).toContain(logName);
});
