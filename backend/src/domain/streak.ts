import { addDays, type StudyDate } from '../lib/kst.ts';

/**
 * 연속 학습일 계산 (AGENTS.md §9 #4, 2026-08-17 확정).
 *
 * 규칙: **전날 미완료 시 리셋. 별도 유예 없음.**
 * 09 §1 의 "01:00 KST 까지 전날 세션 완료 가능" 유예창이 이미 완충 역할을 하므로
 * streak 자체에 추가 유예를 두지 않는다.
 *
 * streak 는 완료 시각이 아니라 **세션의 study_date** 로 귀속한다 (09 §1).
 * 그래서 23:59 에 시작해 다음 날 00:30 에 완료해도 전날 streak 로 계산된다.
 */

export interface StreakState {
  streakDays: number;
  lastStreakDate: StudyDate | null;
}

export function nextStreak(current: StreakState, completedStudyDate: StudyDate): StreakState {
  const { lastStreakDate } = current;

  // 같은 날짜를 다시 완료 처리해도 늘어나지 않는다 (complete 재요청 대비).
  if (lastStreakDate === completedStudyDate) {
    return current;
  }

  // 과거 세션을 뒤늦게 완료한 경우 streak 를 되돌리지 않는다.
  if (lastStreakDate != null && lastStreakDate > completedStudyDate) {
    return current;
  }

  if (lastStreakDate != null && lastStreakDate === addDays(completedStudyDate, -1)) {
    return { streakDays: current.streakDays + 1, lastStreakDate: completedStudyDate };
  }

  return { streakDays: 1, lastStreakDate: completedStudyDate };
}
