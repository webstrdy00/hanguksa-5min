import { addDays, startOfKstDay, type StudyDate } from '../lib/kst.ts';

/**
 * 오답 복습 간격 (07 §2).
 *
 *   오답 → 1일 뒤
 *   정답 → 3일 뒤
 *   정답 → 7일 뒤
 *   재오답 → 1일 단계로 리셋
 *
 * 7일 이후 정책 (AGENTS.md §9 #5, 2026-08-17 확정):
 *   3단계(7일)에서 정답이면 **졸업**시킨다. review_due_at 을 비워 복습 큐에서 제거한다.
 *   나중에 다시 틀리면 1단계부터 다시 시작한다.
 *   문서가 "MVP 실험용 정책"이라고 명시한 값이므로 데이터를 보고 조정한다.
 *
 * 기한은 시각이 아니라 **KST 날짜 00:00** 로 잡는다.
 * now + 24시간으로 두면 밤 늦게 푼 문항이 다음 날 세션 생성 시각에 아직 기한이 안 돼
 * 복습 후보에서 빠지는 문제가 생긴다.
 */

export const REVIEW_INTERVAL_DAYS: Readonly<Record<1 | 2 | 3, number>> = {
  1: 1,
  2: 3,
  3: 7,
};

/** 0 = 복습 큐에 없음, 1~3 = 간격 단계 */
export type IntervalStep = 0 | 1 | 2 | 3;

export interface ReviewState {
  intervalStep: IntervalStep;
  /** null 이면 복습 큐에 들어가지 않는다(한 번도 틀리지 않았거나 졸업). */
  reviewDueAt: Date | null;
  lastResult: 'correct' | 'wrong';
}

function isIntervalStep(value: number): value is IntervalStep {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

export function normalizeIntervalStep(value: number | null | undefined): IntervalStep {
  if (value == null || !isIntervalStep(value)) return 0;
  return value;
}

function dueAfter(studyDate: StudyDate, step: 1 | 2 | 3): Date {
  return startOfKstDay(addDays(studyDate, REVIEW_INTERVAL_DAYS[step]));
}

/**
 * 답안 결과로 다음 복습 상태를 계산한다.
 *
 * @param currentStep 기존 간격 단계 (처음 보는 문항이면 null)
 * @param isCorrect   서버가 판정한 정답 여부
 * @param studyDate   그 답안이 속한 세션의 KST 학습일
 */
export function nextReviewState(
  currentStep: number | null,
  isCorrect: boolean,
  studyDate: StudyDate,
): ReviewState {
  if (!isCorrect) {
    // 재오답이면 몇 단계였든 1단계로 되돌린다.
    return { intervalStep: 1, reviewDueAt: dueAfter(studyDate, 1), lastResult: 'wrong' };
  }

  const step = normalizeIntervalStep(currentStep);

  // 한 번도 틀린 적 없는 문항은 복습 큐에 넣지 않는다.
  if (step === 0) {
    return { intervalStep: 0, reviewDueAt: null, lastResult: 'correct' };
  }

  if (step === 1) {
    return { intervalStep: 2, reviewDueAt: dueAfter(studyDate, 2), lastResult: 'correct' };
  }

  if (step === 2) {
    return { intervalStep: 3, reviewDueAt: dueAfter(studyDate, 3), lastResult: 'correct' };
  }

  // 7일 단계까지 맞혔으면 졸업.
  return { intervalStep: 3, reviewDueAt: null, lastResult: 'correct' };
}

/** 복습 큐에서 빠진 상태인지 (한 번도 안 틀렸거나 졸업). */
export function isGraduated(state: { intervalStep: number; reviewDueAt: Date | null }): boolean {
  return state.reviewDueAt == null && state.intervalStep === 3;
}

/**
 * 오답노트에서 "복습 완료"로 볼지 판단한다 (AGENTS.md §9 #6, 2026-08-17 확정).
 *
 * 오답노트 복습은 정답 판정이 없는 자율 열람이다.
 * 그래서 last_reviewed_at 만 기록하고 복습 간격과 숙련도는 건드리지 않는다.
 * 간격을 전진시키면 실제 재출제 기회를 잃어 학습 효과가 떨어지고,
 * 숙련도에 반영하면 풀지도 않은 문항으로 정답률이 부풀려진다.
 *
 * 마지막으로 문항을 만난 시점 이후에 복습했으면 완료로 본다.
 */
export function isReviewed(lastSeenAt: Date, lastReviewedAt: Date | null): boolean {
  if (lastReviewedAt == null) return false;
  return lastReviewedAt.getTime() >= lastSeenAt.getTime();
}
