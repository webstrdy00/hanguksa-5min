import { ERAS, TOPICS, type Era, type Topic } from '../db/schema/enums.ts';
import { smoothedAccuracy } from './session-scheduler.ts';

/**
 * 시대×주제 숙련도와 학습현황 (07 §3, 02 UX, 07 §9).
 *
 * 표시 규칙 (07 §3, 위반 금지):
 * - seen_count 가 5 미만이면 **숫자 퍼센트를 응답에 넣지 않는다.**
 *   프론트에서 숨기는 방식이 아니라 서버가 아예 내려보내지 않는다.
 * - 내부 모델 점수(smoothed_accuracy 원값)를 노출하지 않는다.
 * - 어떤 형태로도 합격 확률로 변환하지 않는다.
 */

/** 07 §3: 노출 5회 미만은 "데이터 부족" */
export const MIN_SEEN_FOR_PERCENT = 5;

export interface AnswerFact {
  era: Era;
  topic: Topic;
  isCorrect: boolean;
  /** voided 문항은 집계에서 제외한다 (07 §9). */
  revisionStatus: string;
  answeredAt: Date;
}

export interface MasteryAggregate {
  era: Era;
  topic: Topic;
  seenCount: number;
  correctCount: number;
  lastSeenAt: Date;
}

/**
 * 답안 이력에서 숙련도를 다시 계산한다.
 *
 * void 처리 후 재계산에 쓰는 함수이므로 **멱등**해야 한다.
 * 같은 입력이면 항상 같은 결과가 나온다 (07 §9).
 */
export function aggregateMastery(facts: AnswerFact[]): MasteryAggregate[] {
  const byArea = new Map<string, MasteryAggregate>();

  for (const fact of facts) {
    // 문항 오류로 사용자를 벌하지 않는다. void 는 통계에서 빼기만 한다.
    if (fact.revisionStatus === 'voided') continue;

    const key = `${fact.era}:${fact.topic}`;
    const current = byArea.get(key);

    if (current == null) {
      byArea.set(key, {
        era: fact.era,
        topic: fact.topic,
        seenCount: 1,
        correctCount: fact.isCorrect ? 1 : 0,
        lastSeenAt: fact.answeredAt,
      });
      continue;
    }

    current.seenCount += 1;
    if (fact.isCorrect) current.correctCount += 1;
    if (fact.answeredAt.getTime() > current.lastSeenAt.getTime()) {
      current.lastSeenAt = fact.answeredAt;
    }
  }

  return [...byArea.values()].sort((left, right) => {
    const eraDiff = ERAS.indexOf(left.era) - ERAS.indexOf(right.era);
    if (eraDiff !== 0) return eraDiff;
    return TOPICS.indexOf(left.topic) - TOPICS.indexOf(right.topic);
  });
}

/**
 * 화면에 쓰는 상태 라벨.
 * insufficient_data = 데이터 부족(퍼센트 미제공)
 * weak              = 내 평균보다 낮은 영역 (복습 우선 대상)
 * normal            = 그 외
 */
export type ProgressStatus = 'insufficient_data' | 'weak' | 'normal';

export interface TopicProgress {
  topic: Topic;
  seenCount: number;
  correctCount: number;
  accuracyPercent: number | null;
  status: ProgressStatus;
}

export interface EraProgress {
  era: Era;
  seenCount: number;
  correctCount: number;
  /** seen_count >= 5 일 때만 채운다. 미만이면 null 이다 (07 §3). */
  accuracyPercent: number | null;
  status: ProgressStatus;
  topics: TopicProgress[];
}

export interface ProgressSummary {
  totalSeen: number;
  totalCorrect: number;
  /** 전체 노출이 5회 미만이면 null */
  accuracyPercent: number | null;
  /** 복습을 권할 시대. 데이터가 부족하면 빈 배열이다. */
  weakEras: Era[];
}

export interface ProgressView {
  eras: EraProgress[];
  summary: ProgressSummary;
}

function toPercent(correctCount: number, seenCount: number): number | null {
  if (seenCount < MIN_SEEN_FOR_PERCENT) return null;
  return Math.round((correctCount / seenCount) * 100);
}

/**
 * 취약 판정은 **사용자 자신의 평균 대비 상대 비교**로 한다.
 *
 * 문서에 절대 기준(예: 60% 미만)이 없어서 임의의 숫자를 만들지 않는다.
 * 스케줄러의 취약 영역 선정도 "smoothed_accuracy 최저"라는 상대 기준이므로(07 §2)
 * 화면 라벨과 실제 출제 기준이 어긋나지 않는다.
 */
function decideStatus(
  seenCount: number,
  correctCount: number,
  averageSmoothed: number | null,
): ProgressStatus {
  if (seenCount < MIN_SEEN_FOR_PERCENT) return 'insufficient_data';
  if (averageSmoothed == null) return 'normal';
  return smoothedAccuracy(correctCount, seenCount) < averageSmoothed ? 'weak' : 'normal';
}

export function buildProgressView(rows: MasteryAggregate[]): ProgressView {
  const byEra = new Map<
    Era,
    { seenCount: number; correctCount: number; topics: TopicProgress[] }
  >();

  for (const row of rows) {
    const current = byEra.get(row.era) ?? { seenCount: 0, correctCount: 0, topics: [] };
    current.seenCount += row.seenCount;
    current.correctCount += row.correctCount;
    current.topics.push({
      topic: row.topic,
      seenCount: row.seenCount,
      correctCount: row.correctCount,
      accuracyPercent: toPercent(row.correctCount, row.seenCount),
      status: 'normal',
    });
    byEra.set(row.era, current);
  }

  // 판정에 쓸 평균은 표본이 충분한 시대만으로 낸다.
  const qualified = [...byEra.entries()].filter(
    ([, value]) => value.seenCount >= MIN_SEEN_FOR_PERCENT,
  );

  const averageSmoothed =
    qualified.length === 0
      ? null
      : qualified.reduce(
          (sum, [, value]) => sum + smoothedAccuracy(value.correctCount, value.seenCount),
          0,
        ) / qualified.length;

  const eras: EraProgress[] = ERAS.map((era) => {
    const value = byEra.get(era) ?? { seenCount: 0, correctCount: 0, topics: [] };

    const topics = value.topics.map((topic) => ({
      ...topic,
      status: decideStatus(topic.seenCount, topic.correctCount, averageSmoothed),
    }));

    return {
      era,
      seenCount: value.seenCount,
      correctCount: value.correctCount,
      accuracyPercent: toPercent(value.correctCount, value.seenCount),
      status: decideStatus(value.seenCount, value.correctCount, averageSmoothed),
      topics: topics.sort(
        (left, right) => TOPICS.indexOf(left.topic) - TOPICS.indexOf(right.topic),
      ),
    };
  });

  const totalSeen = rows.reduce((sum, row) => sum + row.seenCount, 0);
  const totalCorrect = rows.reduce((sum, row) => sum + row.correctCount, 0);

  return {
    eras,
    summary: {
      totalSeen,
      totalCorrect,
      accuracyPercent: toPercent(totalCorrect, totalSeen),
      weakEras: eras.filter((era) => era.status === 'weak').map((era) => era.era),
    },
  };
}
