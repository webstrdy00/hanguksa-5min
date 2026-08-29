import { and, count, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { questionRevisions } from '../db/schema/content.ts';
import type { Era, Topic } from '../db/schema/enums.ts';
import { users } from '../db/schema/identity.ts';
import { answers, mastery, studySessionItems, studySessions } from '../db/schema/learning.ts';
import {
  aggregateMastery,
  buildProgressView,
  type AnswerFact,
  type MasteryAggregate,
  type ProgressView,
} from '../domain/mastery.ts';
import { addDays, startOfKstDay, toStudyDate, type StudyDate } from '../lib/kst.ts';

/**
 * 학습현황 (08 §2 GET /v1/progress, 02 UX 학습현황 화면).
 *
 * 07 §3 표시 규칙은 domain/mastery.ts 가 강제한다.
 * 이 파일은 데이터를 모으고 최근 7일 이력을 붙이는 역할만 한다.
 */

const RECENT_DAYS = 7;

export interface DailyRecord {
  studyDate: StudyDate;
  completed: boolean;
  /** 완료 전에는 null */
  score: number | null;
  answeredCount: number;
}

export interface ProgressResponse extends ProgressView {
  streak: { days: number; lastStreakDate: string | null };
  recentDays: DailyRecord[];
}

export async function loadProgress(userId: string, now: Date): Promise<ProgressResponse> {
  const rows = await db
    .select({
      era: mastery.era,
      topic: mastery.topic,
      seenCount: mastery.seenCount,
      correctCount: mastery.correctCount,
      lastSeenAt: mastery.lastSeenAt,
    })
    .from(mastery)
    .where(eq(mastery.userId, userId));

  const aggregates: MasteryAggregate[] = rows.map((row) => ({
    era: row.era as Era,
    topic: row.topic as Topic,
    seenCount: row.seenCount,
    correctCount: row.correctCount,
    lastSeenAt: row.lastSeenAt ?? now,
  }));

  const view = buildProgressView(aggregates);

  const [profile] = await db
    .select({ streakDays: users.streakDays, lastStreakDate: users.lastStreakDate })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    ...view,
    streak: {
      days: profile?.streakDays ?? 0,
      lastStreakDate: profile?.lastStreakDate ?? null,
    },
    recentDays: await loadRecentDays(userId, now),
  };
}

/** 최근 7일 학습 이력. 학습하지 않은 날도 빈 칸으로 채워 달력처럼 쓸 수 있게 한다. */
async function loadRecentDays(userId: string, now: Date): Promise<DailyRecord[]> {
  const today = toStudyDate(now);
  const from = addDays(today, -(RECENT_DAYS - 1));

  const sessions = await db
    .select({
      id: studySessions.id,
      studyDate: studySessions.studyDate,
      completedAt: studySessions.completedAt,
      score: studySessions.score,
    })
    .from(studySessions)
    .where(and(eq(studySessions.userId, userId), gte(studySessions.studyDate, from)))
    .orderBy(desc(studySessions.studyDate));

  // 세션마다 따로 세면 N+1 이 된다. 한 번에 묶어서 센다.
  const answeredCounts = new Map<string, number>();
  const sessionIds = sessions.map((session) => session.id);

  if (sessionIds.length > 0) {
    const counted = await db
      .select({ sessionId: answers.sessionId, total: count() })
      .from(answers)
      .where(inArray(answers.sessionId, sessionIds))
      .groupBy(answers.sessionId);

    for (const row of counted) {
      answeredCounts.set(row.sessionId, row.total);
    }
  }

  const byDate = new Map(sessions.map((session) => [session.studyDate, session]));

  const records: DailyRecord[] = [];
  for (let offset = RECENT_DAYS - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const session = byDate.get(date);

    records.push({
      studyDate: date,
      completed: session?.completedAt != null,
      score: session?.score ?? null,
      answeredCount: session == null ? 0 : (answeredCounts.get(session.id) ?? 0),
    });
  }

  return records;
}

/**
 * 숙련도 전체 재계산 (07 §9).
 *
 * void 처리된 문항을 집계에서 빼고 answers 이력으로부터 mastery 를 다시 만든다.
 * 멱등하다. 몇 번 돌려도 같은 결과가 된다.
 *
 * 7단계에서 void 이벤트와 배치 job 에 연결한다. 여기서는 재계산 자체만 제공한다.
 */
export async function recalculateMastery(userId: string, now: Date): Promise<MasteryAggregate[]> {
  const facts = await db
    .select({
      era: questionRevisions.era,
      topic: questionRevisions.topic,
      isCorrect: answers.isCorrect,
      revisionStatus: questionRevisions.status,
      answeredAt: answers.answeredAt,
    })
    .from(answers)
    .innerJoin(studySessions, eq(studySessions.id, answers.sessionId))
    .innerJoin(
      studySessionItems,
      and(
        eq(studySessionItems.sessionId, answers.sessionId),
        eq(studySessionItems.questionRevisionId, answers.questionRevisionId),
      ),
    )
    .innerJoin(questionRevisions, eq(questionRevisions.id, answers.questionRevisionId))
    .where(eq(studySessions.userId, userId));

  const aggregates = aggregateMastery(facts as AnswerFact[]);

  await db.transaction(async (tx) => {
    // 전량 교체가 가장 단순하고 멱등하다. 사용자당 행 수가 최대 48개(시대 8 × 주제 6)라 부담이 없다.
    await tx.delete(mastery).where(eq(mastery.userId, userId));

    if (aggregates.length > 0) {
      await tx.insert(mastery).values(
        aggregates.map((row) => ({
          userId,
          era: row.era,
          topic: row.topic,
          seenCount: row.seenCount,
          correctCount: row.correctCount,
          lastSeenAt: row.lastSeenAt,
          recalculatedAt: now,
        })),
      );
    }
  });

  return aggregates;
}

/** KST 오늘 00:00 (테스트 및 조회 경계용) */
export function startOfToday(now: Date): Date {
  return startOfKstDay(toStudyDate(now));
}
