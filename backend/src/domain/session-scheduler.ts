import type { Era, SlotSource, Topic } from '../db/schema/enums.ts';

/**
 * 오늘 5문제 선정 알고리즘 (07 §2, 08 §4).
 *
 * 정교한 추천이 아니라 **재현 가능한 규칙 기반 스케줄러**다.
 * 난수를 쓰지 않는다. 같은 입력이면 항상 같은 5개가 나온다.
 *
 * 슬롯 구성: 오답 복습 2 + 취약 영역 1 + 신규 2
 * 부족하면 복습 → 취약 → 신규 순으로 대체하고, 그래도 모자라면 최근 노출 제한을 완화한다.
 */

export const SESSION_SIZE = 5;
export const REVIEW_SLOTS = 2;
export const WEAK_SLOTS = 1;
export const NEW_SLOTS = 2;

/** 07 §2 슬롯 3: 최근 30일 미노출 문항을 신규로 본다. */
export const RECENT_EXPOSURE_DAYS = 30;
/** 07 §2 슬롯 2 / 07 §3: 노출 5회 미만 영역은 취약 판정 대상이 아니다. */
export const WEAK_MIN_SEEN = 5;

/** 07 §3 평활 정확도. 극단값을 줄인다. */
export function smoothedAccuracy(correctCount: number, seenCount: number): number {
  return (correctCount + 2) / (seenCount + 4);
}

/**
 * 목표 급수 → 난이도 선호 순서 (AGENTS.md §9 #9, 2026-08-17 확정).
 *
 * 1급: 어려운 문항 중심(3 → 2 → 1)
 * 2급: 중간 중심(2 → 3 → 1)
 * 3급: 쉬운 문항 중심(1 → 2 → 3)
 * 목표 급수가 없으면 2급 기준을 쓴다.
 */
const DIFFICULTY_PREFERENCE: Readonly<Record<1 | 2 | 3, readonly number[]>> = {
  1: [3, 2, 1],
  2: [2, 3, 1],
  3: [1, 2, 3],
};

export function difficultyRank(targetGrade: number | null, difficulty: number): number {
  const grade = targetGrade === 1 || targetGrade === 3 ? targetGrade : 2;
  const rank = DIFFICULTY_PREFERENCE[grade].indexOf(difficulty);
  return rank === -1 ? DIFFICULTY_PREFERENCE[grade].length : rank;
}

export interface PoolQuestion {
  canonicalQuestionId: string;
  revisionId: string;
  era: Era;
  topic: Topic;
  difficulty: number;
}

export interface UserQuestionSnapshot {
  canonicalQuestionId: string;
  reviewDueAt: Date | null;
  lastSeenAt: Date;
}

export interface MasterySnapshot {
  era: Era;
  topic: Topic;
  seenCount: number;
  correctCount: number;
}

export interface SchedulerInput {
  /** published revision 만 들어온다. retired/voided 는 호출 전에 걸러진다 (08 §4). */
  pool: PoolQuestion[];
  states: UserQuestionSnapshot[];
  mastery: MasterySnapshot[];
  targetGrade: number | null;
  now: Date;
}

export interface SelectedSlot {
  slotIndex: number;
  slotSource: SlotSource;
  canonicalQuestionId: string;
  revisionId: string;
}

function areaKey(era: string, topic: string): string {
  return `${era}:${topic}`;
}

/** 문자열 비교. tie-break 를 결정적으로 만들기 위해 항상 마지막에 넣는다. */
function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function selectDailySet(input: SchedulerInput): SelectedSlot[] {
  const { pool, states, mastery, targetGrade, now } = input;

  const poolByCanonical = new Map<string, PoolQuestion>();
  for (const question of pool) {
    poolByCanonical.set(question.canonicalQuestionId, question);
  }

  const stateByCanonical = new Map<string, UserQuestionSnapshot>();
  for (const state of states) {
    stateByCanonical.set(state.canonicalQuestionId, state);
  }

  const exposureByArea = new Map<string, number>();
  for (const row of mastery) {
    exposureByArea.set(areaKey(row.era, row.topic), row.seenCount);
  }

  const picked = new Set<string>();
  const chosen: { slotSource: SlotSource; question: PoolQuestion }[] = [];

  const take = (question: PoolQuestion, slotSource: SlotSource): void => {
    picked.add(question.canonicalQuestionId);
    chosen.push({ slotSource, question });
  };

  // ---------------------------------------------------------------------------
  // 슬롯 1: 오답 복습 — review_due_at 이 지난 문항 중 오래된 순
  // ---------------------------------------------------------------------------
  const reviewQueue = states
    .filter((state) => {
      if (state.reviewDueAt == null) return false;
      if (state.reviewDueAt.getTime() > now.getTime()) return false;
      return poolByCanonical.has(state.canonicalQuestionId);
    })
    .sort((left, right) => {
      const dueDiff = (left.reviewDueAt?.getTime() ?? 0) - (right.reviewDueAt?.getTime() ?? 0);
      if (dueDiff !== 0) return dueDiff;
      return compareId(left.canonicalQuestionId, right.canonicalQuestionId);
    });

  const takeFromReview = (limit: number): void => {
    for (const state of reviewQueue) {
      if (limit <= 0) break;
      if (picked.has(state.canonicalQuestionId)) continue;
      const question = poolByCanonical.get(state.canonicalQuestionId);
      if (question == null) continue;
      take(question, 'review');
      limit -= 1;
    }
  };

  takeFromReview(REVIEW_SLOTS);

  // ---------------------------------------------------------------------------
  // 슬롯 2: 취약 영역 — seen_count >= 5 인 영역 중 smoothed_accuracy 최저
  // ---------------------------------------------------------------------------
  const weakAreas = mastery
    .filter((row) => row.seenCount >= WEAK_MIN_SEEN)
    .sort((left, right) => {
      const accuracyDiff =
        smoothedAccuracy(left.correctCount, left.seenCount) -
        smoothedAccuracy(right.correctCount, right.seenCount);
      if (accuracyDiff !== 0) return accuracyDiff;
      // 같은 정확도면 더 많이 본 영역을 먼저 본다(표본이 많아 신뢰도가 높다).
      if (left.seenCount !== right.seenCount) return right.seenCount - left.seenCount;
      const eraDiff = compareId(left.era, right.era);
      if (eraDiff !== 0) return eraDiff;
      return compareId(left.topic, right.topic);
    });

  const orderCandidates = (candidates: PoolQuestion[]): PoolQuestion[] =>
    [...candidates].sort((left, right) => {
      const leftSeen = stateByCanonical.get(left.canonicalQuestionId)?.lastSeenAt ?? null;
      const rightSeen = stateByCanonical.get(right.canonicalQuestionId)?.lastSeenAt ?? null;

      // 한 번도 안 본 문항을 먼저 쓴다.
      if (leftSeen == null && rightSeen != null) return -1;
      if (leftSeen != null && rightSeen == null) return 1;
      if (leftSeen != null && rightSeen != null) {
        const seenDiff = leftSeen.getTime() - rightSeen.getTime();
        if (seenDiff !== 0) return seenDiff;
      }

      const rankDiff =
        difficultyRank(targetGrade, left.difficulty) -
        difficultyRank(targetGrade, right.difficulty);
      if (rankDiff !== 0) return rankDiff;

      return compareId(left.canonicalQuestionId, right.canonicalQuestionId);
    });

  const takeFromWeakAreas = (limit: number): void => {
    for (const area of weakAreas) {
      if (limit <= 0) break;
      const candidates = orderCandidates(
        pool.filter(
          (question) =>
            !picked.has(question.canonicalQuestionId) &&
            question.era === area.era &&
            question.topic === area.topic,
        ),
      );
      const chosenQuestion = candidates[0];
      if (chosenQuestion == null) continue;
      take(chosenQuestion, 'weak');
      limit -= 1;
    }
  };

  takeFromWeakAreas(WEAK_SLOTS);

  // ---------------------------------------------------------------------------
  // 슬롯 3: 신규 — 최근 30일 미노출 + 커버리지가 부족한 영역 우선
  // ---------------------------------------------------------------------------
  const recentThreshold = new Date(now.getTime() - RECENT_EXPOSURE_DAYS * 86_400_000);

  const orderNewCandidates = (candidates: PoolQuestion[]): PoolQuestion[] =>
    [...candidates].sort((left, right) => {
      // 사용자가 덜 본 영역을 먼저 채운다.
      const leftExposure = exposureByArea.get(areaKey(left.era, left.topic)) ?? 0;
      const rightExposure = exposureByArea.get(areaKey(right.era, right.topic)) ?? 0;
      if (leftExposure !== rightExposure) return leftExposure - rightExposure;

      const leftSeen = stateByCanonical.get(left.canonicalQuestionId)?.lastSeenAt ?? null;
      const rightSeen = stateByCanonical.get(right.canonicalQuestionId)?.lastSeenAt ?? null;
      if (leftSeen == null && rightSeen != null) return -1;
      if (leftSeen != null && rightSeen == null) return 1;
      if (leftSeen != null && rightSeen != null) {
        const seenDiff = leftSeen.getTime() - rightSeen.getTime();
        if (seenDiff !== 0) return seenDiff;
      }

      const rankDiff =
        difficultyRank(targetGrade, left.difficulty) -
        difficultyRank(targetGrade, right.difficulty);
      if (rankDiff !== 0) return rankDiff;

      return compareId(left.canonicalQuestionId, right.canonicalQuestionId);
    });

  const takeFromNew = (limit: number): void => {
    const candidates = orderNewCandidates(
      pool.filter((question) => {
        if (picked.has(question.canonicalQuestionId)) return false;
        const state = stateByCanonical.get(question.canonicalQuestionId);
        if (state == null) return true;
        return state.lastSeenAt.getTime() < recentThreshold.getTime();
      }),
    );

    for (const question of candidates) {
      if (limit <= 0) break;
      take(question, 'new');
      limit -= 1;
    }
  };

  takeFromNew(NEW_SLOTS);

  // ---------------------------------------------------------------------------
  // fallback: 복습 → 취약 → 신규 순으로 남은 자리를 채운다 (07 §2)
  // ---------------------------------------------------------------------------
  if (chosen.length < SESSION_SIZE) takeFromReview(SESSION_SIZE - chosen.length);
  if (chosen.length < SESSION_SIZE) takeFromWeakAreas(SESSION_SIZE - chosen.length);
  if (chosen.length < SESSION_SIZE) takeFromNew(SESSION_SIZE - chosen.length);

  // 그래도 부족하면 최근 30일 제한을 풀고 오래 안 본 순서로 채운다.
  if (chosen.length < SESSION_SIZE) {
    const relaxed = orderNewCandidates(
      pool.filter((question) => !picked.has(question.canonicalQuestionId)),
    );
    for (const question of relaxed) {
      if (chosen.length >= SESSION_SIZE) break;
      take(question, 'new');
    }
  }

  return chosen.slice(0, SESSION_SIZE).map((entry, index) => ({
    slotIndex: index,
    slotSource: entry.slotSource,
    canonicalQuestionId: entry.question.canonicalQuestionId,
    revisionId: entry.question.revisionId,
  }));
}
