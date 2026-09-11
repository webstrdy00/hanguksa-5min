import { describe, expect, it } from 'vitest';
import { assertStudyDate } from '../lib/kst.ts';
import { nextStreak } from './streak.ts';

const d = assertStudyDate;

describe('nextStreak (AGENTS.md §9 #4: 전날 미완료 시 리셋, 유예 없음)', () => {
  it('첫 완료는 1일이다', () => {
    expect(nextStreak({ streakDays: 0, lastStreakDate: null }, d('2026-08-17'))).toEqual({
      streakDays: 1,
      lastStreakDate: '2026-08-17',
    });
  });

  it('전날 완료했으면 1 늘어난다', () => {
    expect(nextStreak({ streakDays: 4, lastStreakDate: d('2026-08-16') }, d('2026-08-17'))).toEqual(
      { streakDays: 5, lastStreakDate: '2026-08-17' },
    );
  });

  it('하루라도 건너뛰면 1로 리셋된다', () => {
    expect(
      nextStreak({ streakDays: 30, lastStreakDate: d('2026-08-15') }, d('2026-08-17')),
    ).toEqual({ streakDays: 1, lastStreakDate: '2026-08-17' });
  });

  it('같은 날짜를 다시 완료해도 늘어나지 않는다', () => {
    const current = { streakDays: 7, lastStreakDate: d('2026-08-17') };
    expect(nextStreak(current, d('2026-08-17'))).toEqual(current);
  });

  it('과거 세션을 뒤늦게 완료해도 streak 를 되돌리지 않는다', () => {
    const current = { streakDays: 7, lastStreakDate: d('2026-08-17') };
    expect(nextStreak(current, d('2026-08-10'))).toEqual(current);
  });

  it('월 경계를 넘어도 연속으로 인정한다', () => {
    expect(nextStreak({ streakDays: 2, lastStreakDate: d('2026-08-31') }, d('2026-09-01'))).toEqual(
      { streakDays: 3, lastStreakDate: '2026-09-01' },
    );
  });

  it('연 경계를 넘어도 연속으로 인정한다', () => {
    expect(nextStreak({ streakDays: 9, lastStreakDate: d('2026-12-31') }, d('2027-01-01'))).toEqual(
      { streakDays: 10, lastStreakDate: '2027-01-01' },
    );
  });
});
