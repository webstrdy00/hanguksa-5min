import { describe, expect, it } from 'vitest';
import { assertStudyDate, startOfKstDay } from '../lib/kst.ts';
import {
  REVIEW_INTERVAL_DAYS,
  isGraduated,
  isReviewed,
  nextReviewState,
  normalizeIntervalStep,
} from './review-schedule.ts';

const d = assertStudyDate;
const STUDY_DATE = d('2026-08-17');

/** 기한은 KST 날짜 00:00 이다. */
function dueOn(date: string): number {
  return startOfKstDay(d(date)).getTime();
}

describe('복습 간격 전이 (07 §2)', () => {
  it('처음 틀리면 1일 뒤로 잡는다', () => {
    const state = nextReviewState(null, false, STUDY_DATE);

    expect(state.intervalStep).toBe(1);
    expect(state.lastResult).toBe('wrong');
    expect(state.reviewDueAt?.getTime()).toBe(dueOn('2026-08-18'));
  });

  it('1단계에서 맞히면 3일 뒤로 늘린다', () => {
    const state = nextReviewState(1, true, STUDY_DATE);

    expect(state.intervalStep).toBe(2);
    expect(state.reviewDueAt?.getTime()).toBe(dueOn('2026-08-20'));
  });

  it('2단계에서 맞히면 7일 뒤로 늘린다', () => {
    const state = nextReviewState(2, true, STUDY_DATE);

    expect(state.intervalStep).toBe(3);
    expect(state.reviewDueAt?.getTime()).toBe(dueOn('2026-08-24'));
  });

  it('3단계(7일)에서 맞히면 졸업시켜 복습 큐에서 뺀다', () => {
    const state = nextReviewState(3, true, STUDY_DATE);

    expect(state.intervalStep).toBe(3);
    expect(state.reviewDueAt).toBeNull();
    expect(isGraduated({ intervalStep: state.intervalStep, reviewDueAt: state.reviewDueAt })).toBe(
      true,
    );
  });

  it.each([1, 2, 3])('%s단계에서 다시 틀리면 1단계로 리셋한다', (step) => {
    const state = nextReviewState(step, false, STUDY_DATE);

    expect(state.intervalStep).toBe(1);
    expect(state.reviewDueAt?.getTime()).toBe(dueOn('2026-08-18'));
    expect(state.lastResult).toBe('wrong');
  });

  it('졸업한 문항도 다시 틀리면 복습 큐로 돌아온다', () => {
    const graduated = nextReviewState(3, true, STUDY_DATE);
    const relapsed = nextReviewState(graduated.intervalStep, false, d('2026-09-01'));

    expect(relapsed.intervalStep).toBe(1);
    expect(relapsed.reviewDueAt?.getTime()).toBe(dueOn('2026-09-02'));
  });

  it('한 번도 틀린 적 없는 문항을 맞히면 복습 큐에 넣지 않는다', () => {
    const state = nextReviewState(null, true, STUDY_DATE);

    expect(state.intervalStep).toBe(0);
    expect(state.reviewDueAt).toBeNull();
    expect(state.lastResult).toBe('correct');
  });

  it('간격 값은 1 / 3 / 7 일이다', () => {
    expect(REVIEW_INTERVAL_DAYS).toEqual({ 1: 1, 2: 3, 3: 7 });
  });

  it('월 경계를 넘어도 기한을 정확히 계산한다', () => {
    const state = nextReviewState(2, true, d('2026-08-28'));
    expect(state.reviewDueAt?.getTime()).toBe(dueOn('2026-09-04'));
  });
});

describe('normalizeIntervalStep', () => {
  it('범위를 벗어난 값은 0으로 본다', () => {
    expect(normalizeIntervalStep(null)).toBe(0);
    expect(normalizeIntervalStep(undefined)).toBe(0);
    expect(normalizeIntervalStep(9)).toBe(0);
    expect(normalizeIntervalStep(2)).toBe(2);
  });
});

describe('isReviewed (AGENTS.md §9 #6)', () => {
  const lastSeen = new Date('2026-08-17T05:00:00Z');

  it('복습 기록이 없으면 미복습이다', () => {
    expect(isReviewed(lastSeen, null)).toBe(false);
  });

  it('마지막으로 문항을 만난 뒤에 복습했으면 완료다', () => {
    expect(isReviewed(lastSeen, new Date('2026-08-17T06:00:00Z'))).toBe(true);
  });

  it('다시 틀린 뒤로는 예전 복습 기록이 무효가 된다', () => {
    // 8/17 에 복습했지만 8/20 에 또 틀렸다면 다시 미복습이다.
    const seenAgain = new Date('2026-08-20T05:00:00Z');
    expect(isReviewed(seenAgain, new Date('2026-08-17T06:00:00Z'))).toBe(false);
  });
});
