import { afterEach, expect, it, vi } from 'vitest';
import { Analytics } from '@apps-in-toss/web-framework';
import { ANALYTICS_EVENTS, trackComplete } from './events.ts';

vi.mock('@apps-in-toss/web-framework', () => ({
  Analytics: { log: vi.fn().mockResolvedValue(undefined) },
}));

afterEach(() => vi.clearAllMocks());

it('콘솔에 등록하는 모든 전환 이름이 실제 전송 이름과 일치한다', () => {
  trackComplete('daily_study');
  trackComplete('review');
  trackComplete('notification_agreed');
  expect(vi.mocked(Analytics.log).mock.calls.map(([event]) => event.log_name)).toEqual([
    ANALYTICS_EVENTS.conversion,
    ...ANALYTICS_EVENTS.secondary,
  ]);
});
