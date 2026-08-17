import type { Era, QuestionStatus, Topic } from '../db/schema/enums.ts';
import { ERAS, TOPICS } from '../db/schema/enums.ts';

/**
 * 문항 CMS 도메인 규칙 (04 §6, 07 §4~5, 08 §1, 09 §2·§5).
 *
 * 순수 함수만 둔다. DB 도 HTTP 도 모르게 해서 규칙 자체를 단위 테스트로 못박는다.
 */

/**
 * 상태 전이표.
 *
 * 뒤로 가는 전이는 없다. 잘못 만들었으면 되돌리지 말고 새 revision 을 발행한다.
 * published revision 의 내용은 immutable 이기 때문이다 (08 §1, 09 §2).
 *
 * retired -> voided 를 허용하는 이유:
 *   이미 내린 문항에서 나중에 중대 사실 오류가 발견될 수 있다.
 *   그때 mastery 재계산 대상에 넣으려면 voided 로 표시할 수 있어야 한다 (07 §9).
 */
export const QUESTION_STATE_TRANSITIONS: Readonly<
  Record<QuestionStatus, readonly QuestionStatus[]>
> = {
  draft: ['review'],
  review: ['approved'],
  approved: ['published', 'retired'],
  published: ['retired', 'voided'],
  retired: ['voided'],
  voided: [],
};

export function canTransition(from: QuestionStatus, to: QuestionStatus): boolean {
  return QUESTION_STATE_TRANSITIONS[from].includes(to);
}

/** voided 는 사유 없이 남길 수 없다. 나중에 왜 지웠는지 아무도 모르는 상황을 만들지 않는다. */
export function requiresStatusReason(to: QuestionStatus): boolean {
  return to === 'voided';
}

/** 상태 전이 시 검수자 정보를 서버가 채워야 하는 시점. */
export function assignsReviewer(to: QuestionStatus): boolean {
  return to === 'approved';
}

/** 새 revision 번호. 클라이언트가 보낸 값을 쓰지 않는다. */
export function nextRevisionNumber(currentMax: number | null | undefined): number {
  if (currentMax == null) return 1;
  return currentMax + 1;
}

/**
 * published 필수 메타 (08 §1, 07 §4~5).
 * DB CHECK 가 최종 방어선이지만, API 는 그 전에 무엇이 빠졌는지 알려준다.
 */
export interface PublishRequirementInput {
  sourceRefs: unknown;
  sourceAccessedAt: string | null;
  reviewerId: string | null;
  reviewedAt: Date | string | null;
  /** DB 에서 읽은 값은 text 라서 좁혀지지 않는다. 문자열로 받고 여기서 판단한다. */
  rightsType: string;
}

export function missingPublishRequirements(input: PublishRequirementInput): string[] {
  const missing: string[] = [];

  if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) {
    missing.push('sourceRefs');
  }
  if (input.sourceAccessedAt == null) {
    missing.push('sourceAccessedAt');
  }
  if (input.reviewerId == null) {
    missing.push('reviewerId');
  }
  if (input.reviewedAt == null) {
    missing.push('reviewedAt');
  }
  if (input.rightsType === 'unknown') {
    missing.push('rightsType');
  }

  return missing;
}

/**
 * 콘텐츠 출시 게이트 기준 (07 §4, 09 §5).
 * 앱인토스나 시험기관의 공식 요구량이 아니라 내부 권장치다.
 */
export const CONTENT_GATE = {
  /** 전체 published 문항 최소 수 */
  totalTarget: 300,
  /** 주요 시대 버킷별 최소 수 */
  perEraTarget: 25,
} as const;

export interface CoverageRow {
  era: Era;
  topic: Topic;
  count: number;
}

export interface CoverageReport {
  total: number;
  byEra: { era: Era; count: number; shortfall: number }[];
  byEraTopic: { era: Era; topic: Topic; count: number }[];
  gate: {
    totalTarget: number;
    perEraTarget: number;
    totalShortfall: number;
    erasBelowTarget: Era[];
    passed: boolean;
  };
}

/**
 * 시대×주제 커버리지 집계.
 * 숫자만 채우는 것을 막기 위해 시대 편향을 함께 본다 (09 §5).
 */
export function evaluateCoverage(rows: CoverageRow[]): CoverageReport {
  const eraTotals = new Map<Era, number>();
  for (const era of ERAS) eraTotals.set(era, 0);

  const matrix: { era: Era; topic: Topic; count: number }[] = [];
  for (const era of ERAS) {
    for (const topic of TOPICS) {
      matrix.push({ era, topic, count: 0 });
    }
  }

  let total = 0;
  for (const row of rows) {
    total += row.count;
    eraTotals.set(row.era, (eraTotals.get(row.era) ?? 0) + row.count);

    const cell = matrix.find((item) => item.era === row.era && item.topic === row.topic);
    if (cell != null) cell.count = row.count;
  }

  const byEra = ERAS.map((era) => {
    const count = eraTotals.get(era) ?? 0;
    return { era, count, shortfall: Math.max(0, CONTENT_GATE.perEraTarget - count) };
  });

  const erasBelowTarget = byEra.filter((item) => item.shortfall > 0).map((item) => item.era);
  const totalShortfall = Math.max(0, CONTENT_GATE.totalTarget - total);

  return {
    total,
    byEra,
    byEraTopic: matrix,
    gate: {
      totalTarget: CONTENT_GATE.totalTarget,
      perEraTarget: CONTENT_GATE.perEraTarget,
      totalShortfall,
      erasBelowTarget,
      passed: totalShortfall === 0 && erasBelowTarget.length === 0,
    },
  };
}
