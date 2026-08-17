import { describe, expect, it } from 'vitest';
import { QUESTION_STATUSES, type QuestionStatus } from '../db/schema/enums.ts';
import {
  CONTENT_GATE,
  QUESTION_STATE_TRANSITIONS,
  assignsReviewer,
  canTransition,
  evaluateCoverage,
  missingPublishRequirements,
  nextRevisionNumber,
  requiresStatusReason,
} from './questions.ts';

describe('상태 전이표 (04 §6 + 08 §1)', () => {
  const allowed: [QuestionStatus, QuestionStatus][] = [
    ['draft', 'review'],
    ['review', 'approved'],
    ['approved', 'published'],
    ['approved', 'retired'],
    ['published', 'retired'],
    ['published', 'voided'],
    ['retired', 'voided'],
  ];

  it.each(allowed)('%s -> %s 는 허용한다', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('뒤로 가는 전이는 없다 (수정은 새 revision 으로만)', () => {
    expect(canTransition('review', 'draft')).toBe(false);
    expect(canTransition('approved', 'review')).toBe(false);
    expect(canTransition('published', 'approved')).toBe(false);
    expect(canTransition('retired', 'published')).toBe(false);
  });

  it('draft 에서 바로 발행할 수 없다', () => {
    expect(canTransition('draft', 'published')).toBe(false);
    expect(canTransition('draft', 'approved')).toBe(false);
  });

  it('voided 는 종착 상태다', () => {
    expect(QUESTION_STATE_TRANSITIONS.voided).toHaveLength(0);
    for (const status of QUESTION_STATUSES) {
      expect(canTransition('voided', status)).toBe(false);
    }
  });

  it('같은 상태로의 전이는 허용하지 않는다', () => {
    for (const status of QUESTION_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});

describe('전이 부가 규칙', () => {
  it('voided 는 사유가 필요하다', () => {
    expect(requiresStatusReason('voided')).toBe(true);
    expect(requiresStatusReason('retired')).toBe(false);
    expect(requiresStatusReason('published')).toBe(false);
  });

  it('승인 시점에 검수자를 서버가 기록한다', () => {
    expect(assignsReviewer('approved')).toBe(true);
    expect(assignsReviewer('published')).toBe(false);
    expect(assignsReviewer('review')).toBe(false);
  });
});

describe('nextRevisionNumber', () => {
  it('첫 revision 은 1이다', () => {
    expect(nextRevisionNumber(null)).toBe(1);
    expect(nextRevisionNumber(undefined)).toBe(1);
  });

  it('기존 최대값 + 1 이다', () => {
    expect(nextRevisionNumber(1)).toBe(2);
    expect(nextRevisionNumber(7)).toBe(8);
  });
});

describe('missingPublishRequirements (07 §4~5, 08 §1)', () => {
  const complete = {
    sourceRefs: [{ title: '국사편찬위원회', url: 'https://www.history.go.kr/' }],
    sourceAccessedAt: '2026-08-14',
    reviewerId: '11111111-1111-1111-1111-111111111111',
    reviewedAt: new Date(),
    rightsType: 'self_created',
  };

  it('모두 갖춰지면 빈 배열이다', () => {
    expect(missingPublishRequirements(complete)).toEqual([]);
  });

  it('출처가 비면 발행할 수 없다', () => {
    expect(missingPublishRequirements({ ...complete, sourceRefs: [] })).toContain('sourceRefs');
    expect(missingPublishRequirements({ ...complete, sourceRefs: null })).toContain('sourceRefs');
  });

  it('출처 확인 날짜가 없으면 발행할 수 없다', () => {
    expect(missingPublishRequirements({ ...complete, sourceAccessedAt: null })).toContain(
      'sourceAccessedAt',
    );
  });

  it('검수자와 검수 시각이 없으면 발행할 수 없다', () => {
    expect(missingPublishRequirements({ ...complete, reviewerId: null })).toContain('reviewerId');
    expect(missingPublishRequirements({ ...complete, reviewedAt: null })).toContain('reviewedAt');
  });

  it('권리 구분이 unknown 이면 발행할 수 없다', () => {
    expect(missingPublishRequirements({ ...complete, rightsType: 'unknown' })).toContain(
      'rightsType',
    );
  });

  it('빠진 항목을 모두 모아서 알려준다', () => {
    const missing = missingPublishRequirements({
      sourceRefs: [],
      sourceAccessedAt: null,
      reviewerId: null,
      reviewedAt: null,
      rightsType: 'unknown',
    });

    expect(missing).toHaveLength(5);
  });
});

describe('evaluateCoverage (09 §5 콘텐츠 게이트)', () => {
  it('비어 있으면 전 시대가 미달이다', () => {
    const report = evaluateCoverage([]);

    expect(report.total).toBe(0);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.erasBelowTarget).toHaveLength(8);
    expect(report.gate.totalShortfall).toBe(CONTENT_GATE.totalTarget);
  });

  it('시대별 합계를 집계한다', () => {
    const report = evaluateCoverage([
      { era: 'goryeo', topic: 'politics', count: 10 },
      { era: 'goryeo', topic: 'culture', count: 15 },
      { era: 'modern', topic: 'politics', count: 3 },
    ]);

    expect(report.total).toBe(28);
    expect(report.byEra.find((item) => item.era === 'goryeo')?.count).toBe(25);
    expect(report.byEra.find((item) => item.era === 'goryeo')?.shortfall).toBe(0);
    expect(report.byEra.find((item) => item.era === 'modern')?.shortfall).toBe(22);
  });

  it('시대×주제 매트릭스를 빠짐없이 채운다', () => {
    const report = evaluateCoverage([{ era: 'goryeo', topic: 'politics', count: 1 }]);

    // 시대 8 × 주제 6
    expect(report.byEraTopic).toHaveLength(48);
    expect(report.byEraTopic.filter((cell) => cell.count === 0)).toHaveLength(47);
  });

  it('숫자만 채우고 시대가 편향되면 통과시키지 않는다', () => {
    // 총량은 넘지만 한 시대에 몰려 있는 경우
    const report = evaluateCoverage([{ era: 'goryeo', topic: 'politics', count: 400 }]);

    expect(report.total).toBe(400);
    expect(report.gate.totalShortfall).toBe(0);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.erasBelowTarget).toContain('modern');
  });

  it('총량과 시대 기준을 모두 채우면 통과한다', () => {
    const rows = [
      'prehistoric',
      'ancient',
      'goryeo',
      'joseon_early',
      'joseon_late',
      'enlightenment',
      'japanese_occupation',
      'modern',
    ].map((era) => ({ era: era as never, topic: 'politics' as never, count: 40 }));

    const report = evaluateCoverage(rows);

    expect(report.total).toBe(320);
    expect(report.gate.passed).toBe(true);
    expect(report.gate.erasBelowTarget).toHaveLength(0);
  });
});
