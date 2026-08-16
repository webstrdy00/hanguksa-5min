import { describe, expect, it } from 'vitest';
import { assertStudyDate } from '../lib/kst.ts';
import {
  buildGoalView,
  isGoalExpired,
  isSelectable,
  listUpcomingExams,
  toExamWithDday,
  type ExamScheduleView,
  type ExamStatusValue,
} from './exams.ts';

function exam(
  round: number,
  examDate: string,
  status: ExamStatusValue = 'scheduled',
): ExamScheduleView {
  return {
    id: `exam-${round}`,
    type: 'advanced',
    round,
    examDate: assertStudyDate(examDate),
    status,
  };
}

/** KST 2026-08-16 10:00 */
const NOW = new Date('2026-08-16T01:00:00Z');

describe('toExamWithDday', () => {
  it('서버 KST 기준으로 남은 일수를 계산한다', () => {
    // 제80회 심화 2026-10-17 (문서 기준값)
    expect(toExamWithDday(exam(80, '2026-10-17'), NOW).dday).toBe(62);
  });

  it('시험 당일은 0, 지난 시험은 음수다', () => {
    expect(toExamWithDday(exam(79, '2026-08-16'), NOW).dday).toBe(0);
    expect(toExamWithDday(exam(79, '2026-08-09'), NOW).dday).toBe(-7);
  });

  it('UTC 로는 전날이어도 KST 기준으로 계산한다', () => {
    // 2026-08-16T15:30:00Z = KST 2026-08-17 00:30
    const afterKstMidnight = new Date('2026-08-16T15:30:00Z');
    expect(toExamWithDday(exam(80, '2026-08-17'), afterKstMidnight).dday).toBe(0);
  });
});

describe('isSelectable', () => {
  it('확정된 미래 회차만 목표로 고를 수 있다', () => {
    expect(isSelectable(exam(80, '2026-10-17'), NOW)).toBe(true);
    expect(isSelectable(exam(80, '2026-08-16'), NOW)).toBe(true);
  });

  it('지난 회차는 고를 수 없다', () => {
    expect(isSelectable(exam(79, '2026-08-09'), NOW)).toBe(false);
  });

  it('변경/취소/종료된 회차는 고를 수 없다 (08 §4)', () => {
    expect(isSelectable(exam(80, '2026-10-17', 'changed'), NOW)).toBe(false);
    expect(isSelectable(exam(80, '2026-10-17', 'cancelled'), NOW)).toBe(false);
    expect(isSelectable(exam(80, '2026-10-17', 'completed'), NOW)).toBe(false);
  });
});

describe('isGoalExpired', () => {
  it('시험일이 지나면 다시 골라야 한다', () => {
    expect(isGoalExpired(exam(79, '2026-08-15'), NOW)).toBe(true);
    expect(isGoalExpired(exam(80, '2026-10-17'), NOW)).toBe(false);
  });

  it('시험 당일에는 아직 만료가 아니다', () => {
    expect(isGoalExpired(exam(80, '2026-08-16'), NOW)).toBe(false);
  });

  it('일정 상태가 changed / cancelled 여도 다시 골라야 한다 (08 §4)', () => {
    expect(isGoalExpired(exam(80, '2026-10-17', 'changed'), NOW)).toBe(true);
    expect(isGoalExpired(exam(80, '2026-10-17', 'cancelled'), NOW)).toBe(true);
    expect(isGoalExpired(exam(80, '2026-10-17', 'completed'), NOW)).toBe(true);
  });
});

describe('listUpcomingExams', () => {
  it('지난 회차를 빼고 가까운 순으로 정렬한다', () => {
    const list = listUpcomingExams(
      [exam(81, '2026-11-28'), exam(79, '2026-08-09'), exam(80, '2026-10-17')],
      NOW,
    );

    expect(list.map((item) => item.round)).toEqual([80, 81]);
    expect(list[0]?.dday).toBe(62);
  });

  it('취소/종료된 회차는 목록에서 제외한다', () => {
    const list = listUpcomingExams(
      [exam(80, '2026-10-17', 'cancelled'), exam(81, '2026-11-28', 'completed')],
      NOW,
    );

    expect(list).toHaveLength(0);
  });

  it('변경된 회차는 목록에 남기되 선택은 막는다', () => {
    const list = listUpcomingExams([exam(80, '2026-10-17', 'changed')], NOW);

    expect(list).toHaveLength(1);
    expect(list[0]?.selectable).toBe(false);
  });
});

describe('buildGoalView', () => {
  it('목표가 없으면 다시 고르게 한다', () => {
    const view = buildGoalView(2, null, NOW);

    expect(view.exam).toBeNull();
    expect(view.needsReselection).toBe(true);
  });

  it('유효한 목표는 D-day 와 함께 돌려준다', () => {
    const view = buildGoalView(1, exam(80, '2026-10-17'), NOW);

    expect(view.targetGrade).toBe(1);
    expect(view.exam?.dday).toBe(62);
    expect(view.needsReselection).toBe(false);
  });

  it('목표 회차가 지났으면 재선택 상태로 만든다', () => {
    const view = buildGoalView(3, exam(79, '2026-08-09'), NOW);

    expect(view.exam?.dday).toBe(-7);
    expect(view.needsReselection).toBe(true);
  });
});
