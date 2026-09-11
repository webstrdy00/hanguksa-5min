import { assertStudyDate, daysUntilExam, toStudyDate, type StudyDate } from '../lib/kst.ts';

/**
 * 시험 일정 도메인 규칙 (09 §3, 08 §4).
 *
 * - D-day 는 서버 KST 기준으로만 계산한다. 클라이언트 시계를 쓰지 않는다.
 * - 앱 번들에 날짜를 하드코딩하지 않는다. 전부 exam_schedules 데이터에서 나온다.
 * - 목표 회차가 지났거나 상태가 changed/cancelled 면 다음 목표를 다시 고르게 한다.
 */

export type ExamStatusValue = 'scheduled' | 'changed' | 'cancelled' | 'completed';

export interface ExamScheduleView {
  id: string;
  type: string;
  round: number;
  examDate: StudyDate;
  status: ExamStatusValue;
}

export interface ExamWithDday extends ExamScheduleView {
  /** 남은 일수. 시험 당일은 0, 지났으면 음수. */
  dday: number;
  /** 새 목표로 고를 수 있는 회차인지. */
  selectable: boolean;
}

/** 08 §4: 목표를 다시 골라야 하는 조건. */
export function isGoalExpired(exam: ExamScheduleView, now: Date): boolean {
  if (exam.status === 'cancelled' || exam.status === 'completed' || exam.status === 'changed') {
    return true;
  }
  return daysUntilExam(exam.examDate, now) < 0;
}

/**
 * 새 목표로 선택할 수 있는 회차인지.
 * 일정이 확정(scheduled) 상태이고 아직 지나지 않아야 한다.
 */
export function isSelectable(exam: ExamScheduleView, now: Date): boolean {
  return exam.status === 'scheduled' && daysUntilExam(exam.examDate, now) >= 0;
}

export function toExamWithDday(exam: ExamScheduleView, now: Date): ExamWithDday {
  return {
    ...exam,
    dday: daysUntilExam(exam.examDate, now),
    selectable: isSelectable(exam, now),
  };
}

/**
 * 사용자에게 보여줄 회차 목록.
 * 지난 회차는 제외하고 시험일이 가까운 순으로 정렬한다.
 */
export function listUpcomingExams(exams: ExamScheduleView[], now: Date): ExamWithDday[] {
  return exams
    .map((exam) => toExamWithDday(exam, now))
    .filter((exam) => exam.dday >= 0 && exam.status !== 'cancelled' && exam.status !== 'completed')
    .sort((left, right) => left.dday - right.dday);
}

export interface GoalView {
  targetGrade: number | null;
  exam: ExamWithDday | null;
  /** 다음 목표 선택 UI 로 전환해야 하는지 (08 §4). */
  needsReselection: boolean;
}

export function buildGoalView(
  targetGrade: number | null,
  exam: ExamScheduleView | null,
  now: Date,
): GoalView {
  if (exam == null) {
    return { targetGrade, exam: null, needsReselection: true };
  }

  return {
    targetGrade,
    exam: toExamWithDday(exam, now),
    needsReselection: isGoalExpired(exam, now),
  };
}

/** 'YYYY-MM-DD' 문자열을 KST 달력 날짜로 검증한다. */
export function parseExamDate(value: string): StudyDate {
  return assertStudyDate(value);
}

export function todayInKst(now: Date): StudyDate {
  return toStudyDate(now);
}
