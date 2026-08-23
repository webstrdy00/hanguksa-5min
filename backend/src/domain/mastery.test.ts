import { describe, expect, it } from 'vitest';
import type { Era, Topic } from '../db/schema/enums.ts';
import {
  MIN_SEEN_FOR_PERCENT,
  aggregateMastery,
  buildProgressView,
  type AnswerFact,
  type MasteryAggregate,
} from './mastery.ts';

function fact(overrides: Partial<AnswerFact> = {}): AnswerFact {
  return {
    era: 'goryeo',
    topic: 'politics',
    isCorrect: true,
    revisionStatus: 'published',
    answeredAt: new Date('2026-08-17T05:00:00Z'),
    ...overrides,
  };
}

function area(era: Era, topic: Topic, seenCount: number, correctCount: number): MasteryAggregate {
  return { era, topic, seenCount, correctCount, lastSeenAt: new Date('2026-08-17T05:00:00Z') };
}

describe('aggregateMastery (07 §9)', () => {
  it('시대×주제로 묶어 센다', () => {
    const result = aggregateMastery([
      fact({ isCorrect: true }),
      fact({ isCorrect: false }),
      fact({ era: 'modern', topic: 'society', isCorrect: true }),
    ]);

    expect(result).toHaveLength(2);
    expect(result.find((row) => row.era === 'goryeo')).toMatchObject({
      seenCount: 2,
      correctCount: 1,
    });
  });

  it('void 된 문항은 집계에서 제외한다', () => {
    const result = aggregateMastery([
      fact({ isCorrect: true }),
      fact({ isCorrect: false, revisionStatus: 'voided' }),
      fact({ isCorrect: false, revisionStatus: 'voided' }),
    ]);

    // 오답 2개가 void 라 정답률이 100% 로 보정된다.
    expect(result[0]).toMatchObject({ seenCount: 1, correctCount: 1 });
  });

  it('retired 문항은 집계에 남는다 (내용은 유효하다)', () => {
    const result = aggregateMastery([
      fact({ isCorrect: true }),
      fact({ isCorrect: false, revisionStatus: 'retired' }),
    ]);

    expect(result[0]).toMatchObject({ seenCount: 2, correctCount: 1 });
  });

  it('마지막 학습 시각은 가장 최근 값이다', () => {
    const result = aggregateMastery([
      fact({ answeredAt: new Date('2026-08-10T00:00:00Z') }),
      fact({ answeredAt: new Date('2026-08-17T00:00:00Z') }),
      fact({ answeredAt: new Date('2026-08-12T00:00:00Z') }),
    ]);

    expect(result[0]?.lastSeenAt.toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  it('같은 입력이면 같은 결과다 (재계산 멱등)', () => {
    const facts = [fact(), fact({ isCorrect: false }), fact({ era: 'modern' })];
    expect(aggregateMastery(facts)).toEqual(aggregateMastery(facts));
  });

  it('답안이 없으면 빈 결과다', () => {
    expect(aggregateMastery([])).toEqual([]);
  });
});

describe('buildProgressView — 데이터 부족 표시 (07 §3)', () => {
  it('노출 5회 미만이면 퍼센트를 내려보내지 않는다', () => {
    const view = buildProgressView([area('goryeo', 'politics', 4, 4)]);
    const goryeo = view.eras.find((era) => era.era === 'goryeo');

    expect(goryeo?.seenCount).toBe(4);
    expect(goryeo?.accuracyPercent).toBeNull();
    expect(goryeo?.status).toBe('insufficient_data');
  });

  it('노출 5회부터 퍼센트를 준다', () => {
    const view = buildProgressView([area('goryeo', 'politics', 5, 4)]);
    const goryeo = view.eras.find((era) => era.era === 'goryeo');

    expect(goryeo?.accuracyPercent).toBe(80);
    expect(goryeo?.status).not.toBe('insufficient_data');
    expect(MIN_SEEN_FOR_PERCENT).toBe(5);
  });

  it('학습 이력이 없는 시대도 목록에 나오되 퍼센트는 없다', () => {
    const view = buildProgressView([area('goryeo', 'politics', 10, 5)]);

    expect(view.eras).toHaveLength(8);
    const modern = view.eras.find((era) => era.era === 'modern');
    expect(modern?.seenCount).toBe(0);
    expect(modern?.accuracyPercent).toBeNull();
    expect(modern?.status).toBe('insufficient_data');
  });

  it('전체 요약도 5회 미만이면 퍼센트가 없다', () => {
    const view = buildProgressView([area('goryeo', 'politics', 3, 3)]);
    expect(view.summary.accuracyPercent).toBeNull();
    expect(view.summary.totalSeen).toBe(3);
  });

  it('내부 모델 점수를 응답에 넣지 않는다', () => {
    const view = buildProgressView([area('goryeo', 'politics', 10, 5)]);
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain('smoothed');
    expect(serialized).not.toContain('probability');
    expect(serialized).not.toContain('합격');
  });
});

describe('buildProgressView — 취약 라벨', () => {
  it('내 평균보다 낮은 시대를 취약으로 표시한다', () => {
    const view = buildProgressView([
      area('goryeo', 'politics', 10, 9),
      area('modern', 'politics', 10, 2),
      area('ancient', 'politics', 10, 8),
    ]);

    expect(view.summary.weakEras).toContain('modern');
    expect(view.summary.weakEras).not.toContain('goryeo');
  });

  it('데이터가 부족한 시대는 취약으로 몰지 않는다', () => {
    const view = buildProgressView([
      area('goryeo', 'politics', 10, 9),
      area('modern', 'politics', 2, 0),
    ]);

    expect(view.eras.find((era) => era.era === 'modern')?.status).toBe('insufficient_data');
    expect(view.summary.weakEras).not.toContain('modern');
  });

  it('표본이 충분한 영역이 하나도 없으면 취약 목록이 비어 있다', () => {
    const view = buildProgressView([area('goryeo', 'politics', 3, 1)]);
    expect(view.summary.weakEras).toEqual([]);
  });

  it('주제 단위 정답률도 함께 준다', () => {
    const view = buildProgressView([
      area('goryeo', 'politics', 6, 6),
      area('goryeo', 'culture', 6, 1),
    ]);

    const goryeo = view.eras.find((era) => era.era === 'goryeo');
    expect(goryeo?.seenCount).toBe(12);
    expect(goryeo?.topics).toHaveLength(2);
    expect(goryeo?.topics.find((topic) => topic.topic === 'culture')?.accuracyPercent).toBe(17);
  });
});
