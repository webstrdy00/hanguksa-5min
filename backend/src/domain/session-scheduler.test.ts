import { describe, expect, it } from 'vitest';
import {
  NEW_SLOTS,
  REVIEW_SLOTS,
  SESSION_SIZE,
  WEAK_SLOTS,
  difficultyRank,
  selectDailySet,
  smoothedAccuracy,
  type MasterySnapshot,
  type PoolQuestion,
  type SchedulerInput,
  type UserQuestionSnapshot,
} from './session-scheduler.ts';

/** KST 2026-08-17 10:00 */
const NOW = new Date('2026-08-17T01:00:00Z');

function question(id: string, overrides: Partial<PoolQuestion> = {}): PoolQuestion {
  return {
    canonicalQuestionId: `q-${id}`,
    revisionId: `r-${id}`,
    era: 'goryeo',
    topic: 'politics',
    difficulty: 2,
    ...overrides,
  };
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

function input(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    pool: [],
    states: [],
    mastery: [],
    targetGrade: 2,
    now: NOW,
    ...overrides,
  };
}

describe('슬롯 구성 (07 §2: 복습 2 + 취약 1 + 신규 2)', () => {
  it('후보가 충분하면 2 + 1 + 2 로 채운다', () => {
    const pool: PoolQuestion[] = [
      question('r1'),
      question('r2'),
      question('weak', { era: 'modern', topic: 'society' }),
      question('n1', { era: 'ancient', topic: 'culture' }),
      question('n2', { era: 'joseon_late', topic: 'economy' }),
    ];

    const states: UserQuestionSnapshot[] = [
      { canonicalQuestionId: 'q-r1', reviewDueAt: daysAgo(2), lastSeenAt: daysAgo(3) },
      { canonicalQuestionId: 'q-r2', reviewDueAt: daysAgo(1), lastSeenAt: daysAgo(2) },
    ];

    const mastery: MasterySnapshot[] = [
      { era: 'modern', topic: 'society', seenCount: 10, correctCount: 2 },
      { era: 'ancient', topic: 'culture', seenCount: 10, correctCount: 9 },
    ];

    const result = selectDailySet(input({ pool, states, mastery }));

    expect(result).toHaveLength(SESSION_SIZE);
    expect(result.filter((slot) => slot.slotSource === 'review')).toHaveLength(REVIEW_SLOTS);
    expect(result.filter((slot) => slot.slotSource === 'weak')).toHaveLength(WEAK_SLOTS);
    expect(result.filter((slot) => slot.slotSource === 'new')).toHaveLength(NEW_SLOTS);
  });

  it('복습 후보를 기한이 오래된 순으로 고른다', () => {
    const pool = [question('a'), question('b'), question('c'), question('d'), question('e')];
    const states: UserQuestionSnapshot[] = [
      { canonicalQuestionId: 'q-b', reviewDueAt: daysAgo(1), lastSeenAt: daysAgo(1) },
      { canonicalQuestionId: 'q-a', reviewDueAt: daysAgo(5), lastSeenAt: daysAgo(5) },
      { canonicalQuestionId: 'q-c', reviewDueAt: daysAgo(3), lastSeenAt: daysAgo(3) },
    ];

    const result = selectDailySet(input({ pool, states }));
    const reviews = result.filter((slot) => slot.slotSource === 'review');

    // 앞의 2개가 복습 슬롯이고 기한이 오래된 순이다.
    // 신규 후보가 모자라면 남은 복습 후보(q-b)가 빈 자리를 채운다.
    expect(reviews.slice(0, 2).map((slot) => slot.canonicalQuestionId)).toEqual(['q-a', 'q-c']);
  });

  it('아직 기한이 안 된 복습 문항은 고르지 않는다', () => {
    const pool = [question('a'), question('b'), question('c'), question('d'), question('e')];
    const states: UserQuestionSnapshot[] = [
      {
        canonicalQuestionId: 'q-a',
        reviewDueAt: new Date(NOW.getTime() + 86_400_000),
        lastSeenAt: daysAgo(1),
      },
    ];

    const result = selectDailySet(input({ pool, states }));
    expect(result.filter((slot) => slot.slotSource === 'review')).toHaveLength(0);
  });

  it('복습이 부족하면 취약/신규로 대체한다', () => {
    const pool = [
      question('a'),
      question('b'),
      question('c'),
      question('d'),
      question('e', { era: 'modern', topic: 'society' }),
    ];
    const states: UserQuestionSnapshot[] = [
      { canonicalQuestionId: 'q-a', reviewDueAt: daysAgo(1), lastSeenAt: daysAgo(40) },
    ];
    const mastery: MasterySnapshot[] = [
      { era: 'modern', topic: 'society', seenCount: 8, correctCount: 1 },
    ];

    const result = selectDailySet(input({ pool, states, mastery }));

    expect(result).toHaveLength(SESSION_SIZE);
    expect(result.filter((slot) => slot.slotSource === 'review')).toHaveLength(1);
  });

  it('취약 데이터가 부족하면(seen_count < 5) 신규로 대체한다', () => {
    const pool = [question('a'), question('b'), question('c'), question('d'), question('e')];
    const mastery: MasterySnapshot[] = [
      { era: 'goryeo', topic: 'politics', seenCount: 4, correctCount: 0 },
    ];

    const result = selectDailySet(input({ pool, mastery }));

    expect(result).toHaveLength(SESSION_SIZE);
    expect(result.filter((slot) => slot.slotSource === 'weak')).toHaveLength(0);
    expect(result.filter((slot) => slot.slotSource === 'new')).toHaveLength(SESSION_SIZE);
  });

  it('취약 영역은 평활 정확도가 가장 낮은 곳을 고른다', () => {
    const pool = [
      question('low', { era: 'modern', topic: 'society' }),
      question('mid', { era: 'ancient', topic: 'culture' }),
      question('x1', { era: 'goryeo', topic: 'politics' }),
      question('x2', { era: 'goryeo', topic: 'economy' }),
      question('x3', { era: 'goryeo', topic: 'figure' }),
    ];
    const mastery: MasterySnapshot[] = [
      { era: 'ancient', topic: 'culture', seenCount: 10, correctCount: 6 },
      { era: 'modern', topic: 'society', seenCount: 10, correctCount: 1 },
    ];

    const result = selectDailySet(input({ pool, mastery }));
    const weak = result.find((slot) => slot.slotSource === 'weak');

    expect(weak?.canonicalQuestionId).toBe('q-low');
  });
});

describe('신규 문항 규칙 (07 §2 슬롯 3)', () => {
  it('최근 30일 안에 본 문항은 신규 후보가 아니다', () => {
    const pool = [question('a'), question('b'), question('c')];
    const states: UserQuestionSnapshot[] = [
      { canonicalQuestionId: 'q-a', reviewDueAt: null, lastSeenAt: daysAgo(5) },
      { canonicalQuestionId: 'q-b', reviewDueAt: null, lastSeenAt: daysAgo(31) },
    ];

    const result = selectDailySet(input({ pool, states }));
    const ids = result.map((slot) => slot.canonicalQuestionId);

    // q-c(미노출) → q-b(31일 전) 순서로 뽑히고, q-a 는 완화 단계에서만 들어온다.
    expect(ids.indexOf('q-c')).toBeLessThan(ids.indexOf('q-b'));
    expect(ids.indexOf('q-b')).toBeLessThan(ids.indexOf('q-a'));
  });

  it('사용자가 덜 본 영역을 먼저 채운다', () => {
    const pool = [
      question('seen-area', { era: 'goryeo', topic: 'politics' }),
      question('fresh-area', { era: 'modern', topic: 'culture' }),
    ];
    // 취약 판정 기준(5회) 미만이라 취약 슬롯에는 걸리지 않고 노출량 정렬에만 쓰인다.
    const mastery: MasterySnapshot[] = [
      { era: 'goryeo', topic: 'politics', seenCount: 4, correctCount: 2 },
    ];

    const result = selectDailySet(input({ pool, mastery }));

    expect(result.every((slot) => slot.slotSource === 'new')).toBe(true);
    expect(result[0]?.canonicalQuestionId).toBe('q-fresh-area');
  });

  it('후보가 모자라면 최근 30일 제한을 풀어 오래 안 본 순으로 채운다', () => {
    const pool = [question('a'), question('b'), question('c'), question('d'), question('e')];
    const states: UserQuestionSnapshot[] = pool.map((item, index) => ({
      canonicalQuestionId: item.canonicalQuestionId,
      reviewDueAt: null,
      lastSeenAt: daysAgo(index + 1),
    }));

    const result = selectDailySet(input({ pool, states }));

    expect(result).toHaveLength(SESSION_SIZE);
    // 가장 오래 안 본 q-e 가 먼저 온다.
    expect(result[0]?.canonicalQuestionId).toBe('q-e');
  });

  it('풀이 5개 미만이면 있는 만큼만 돌려준다', () => {
    const result = selectDailySet(input({ pool: [question('a'), question('b')] }));
    expect(result).toHaveLength(2);
  });
});

describe('재현성과 중복 방지 (08 §4)', () => {
  const pool = [
    question('a', { difficulty: 1 }),
    question('b', { difficulty: 3, era: 'modern' }),
    question('c', { difficulty: 2, topic: 'culture' }),
    question('d', { difficulty: 2, era: 'ancient' }),
    question('e', { difficulty: 1, topic: 'economy' }),
    question('f', { difficulty: 3, era: 'joseon_late' }),
  ];

  it('같은 입력이면 항상 같은 결과다', () => {
    const first = selectDailySet(input({ pool }));
    const second = selectDailySet(input({ pool }));

    expect(second).toEqual(first);
  });

  it('입력 순서가 바뀌어도 결과가 같다 (정렬이 결정적)', () => {
    const first = selectDailySet(input({ pool }));
    const shuffled = selectDailySet(input({ pool: [...pool].reverse() }));

    expect(shuffled.map((slot) => slot.canonicalQuestionId)).toEqual(
      first.map((slot) => slot.canonicalQuestionId),
    );
  });

  it('같은 문항이 두 번 들어가지 않는다', () => {
    const states: UserQuestionSnapshot[] = [
      { canonicalQuestionId: 'q-a', reviewDueAt: daysAgo(1), lastSeenAt: daysAgo(40) },
    ];
    const mastery: MasterySnapshot[] = [
      { era: 'goryeo', topic: 'politics', seenCount: 9, correctCount: 1 },
    ];

    const result = selectDailySet(input({ pool, states, mastery }));
    const ids = result.map((slot) => slot.canonicalQuestionId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('slotIndex 는 0부터 순서대로 매겨진다', () => {
    const result = selectDailySet(input({ pool }));
    expect(result.map((slot) => slot.slotIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('출제 풀에 없는 복습 문항은 건너뛴다 (retired/voided 제외 결과)', () => {
    const states: UserQuestionSnapshot[] = [
      { canonicalQuestionId: 'q-removed', reviewDueAt: daysAgo(1), lastSeenAt: daysAgo(1) },
    ];

    const result = selectDailySet(input({ pool, states }));

    expect(result.map((slot) => slot.canonicalQuestionId)).not.toContain('q-removed');
    expect(result).toHaveLength(SESSION_SIZE);
  });
});

describe('목표 급수별 난이도 선호 (AGENTS.md §9 #9)', () => {
  it('1급은 어려운 문항을, 3급은 쉬운 문항을 먼저 고른다', () => {
    expect(difficultyRank(1, 3)).toBeLessThan(difficultyRank(1, 1));
    expect(difficultyRank(3, 1)).toBeLessThan(difficultyRank(3, 3));
    expect(difficultyRank(2, 2)).toBeLessThan(difficultyRank(2, 1));
  });

  it('목표 급수가 없으면 2급 기준을 쓴다', () => {
    expect(difficultyRank(null, 2)).toBe(difficultyRank(2, 2));
    expect(difficultyRank(null, 3)).toBe(difficultyRank(2, 3));
  });

  it('같은 영역에서 급수에 맞는 난이도를 먼저 배정한다', () => {
    const pool = [question('easy', { difficulty: 1 }), question('hard', { difficulty: 3 })];

    const forGrade1 = selectDailySet(input({ pool, targetGrade: 1 }));
    const forGrade3 = selectDailySet(input({ pool, targetGrade: 3 }));

    expect(forGrade1[0]?.canonicalQuestionId).toBe('q-hard');
    expect(forGrade3[0]?.canonicalQuestionId).toBe('q-easy');
  });
});

describe('smoothedAccuracy (07 §3)', () => {
  it('(correct + 2) / (seen + 4) 를 쓴다', () => {
    expect(smoothedAccuracy(0, 0)).toBeCloseTo(0.5);
    expect(smoothedAccuracy(0, 10)).toBeCloseTo(2 / 14);
    expect(smoothedAccuracy(10, 10)).toBeCloseTo(12 / 14);
  });

  it('표본이 적을 때 극단값을 완화한다', () => {
    // 1문제 다 틀림: 0% 가 아니라 40% 로 본다.
    expect(smoothedAccuracy(0, 1)).toBeCloseTo(0.4);
  });
});
