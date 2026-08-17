import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { questionRevisions } from '../db/schema/content.ts';
import { users } from '../db/schema/identity.ts';
import {
  answers,
  mastery,
  studySessionItems,
  studySessions,
  userQuestionState,
} from '../db/schema/learning.ts';
import { AppError } from '../http/errors.ts';
import { assertStudyDate, canCompleteSessionAt, toStudyDate, type StudyDate } from '../lib/kst.ts';
import {
  SESSION_SIZE,
  selectDailySet,
  type MasterySnapshot,
  type PoolQuestion,
} from '../domain/session-scheduler.ts';
import { nextReviewState } from '../domain/review-schedule.ts';
import { nextStreak } from '../domain/streak.ts';

/**
 * 오늘 학습 세션 (08 §2·§4, 09 §1~2).
 *
 * 서버가 정하는 것: study_date, 5문항 구성, 정답 여부, 점수, 완료 상태, streak.
 * 클라이언트는 어떤 문항을 풀지도, 며칠인지도 결정하지 않는다.
 */

export interface SessionItemView {
  slotIndex: number;
  slotSource: string;
  questionRevisionId: string;
  era: string;
  topic: string;
  difficulty: number;
  prompt: string;
  choices: string[];
  /** voided 문항은 유효 답안에서 제외된다 (07 §9). */
  voided: boolean;
  answered: boolean;
  selectedIndex?: number;
  isCorrect?: boolean;
  /** 답한 문항에만 채워진다. 풀기 전에는 정답을 내려보내지 않는다. */
  correctIndex?: number;
  explanation?: string;
}

export interface SessionView {
  session: {
    id: string;
    studyDate: StudyDate;
    completedAt: string | null;
    score: number | null;
    createdAt: string;
  };
  items: SessionItemView[];
}

function toChoices(value: unknown): string[] {
  return Array.isArray(value) ? value.map((choice) => String(choice)) : [];
}

/** 세션과 문항을 조회해 응답 형태로 만든다. 정답은 답한 문항에만 포함한다. */
async function loadSessionView(sessionId: string): Promise<SessionView> {
  const [session] = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.id, sessionId))
    .limit(1);

  if (session == null) throw new AppError('NOT_FOUND');

  const rows = await db
    .select({
      slotIndex: studySessionItems.slotIndex,
      slotSource: studySessionItems.slotSource,
      revisionId: questionRevisions.id,
      era: questionRevisions.era,
      topic: questionRevisions.topic,
      difficulty: questionRevisions.difficulty,
      prompt: questionRevisions.prompt,
      choices: questionRevisions.choices,
      correctIndex: questionRevisions.correctIndex,
      explanation: questionRevisions.explanation,
      status: questionRevisions.status,
      selectedIndex: answers.selectedIndex,
      isCorrect: answers.isCorrect,
    })
    .from(studySessionItems)
    .innerJoin(questionRevisions, eq(questionRevisions.id, studySessionItems.questionRevisionId))
    .leftJoin(
      answers,
      and(
        eq(answers.sessionId, studySessionItems.sessionId),
        eq(answers.questionRevisionId, studySessionItems.questionRevisionId),
      ),
    )
    .where(eq(studySessionItems.sessionId, sessionId))
    .orderBy(studySessionItems.slotIndex);

  return {
    session: {
      id: session.id,
      studyDate: assertStudyDate(session.studyDate),
      completedAt: session.completedAt?.toISOString() ?? null,
      score: session.score,
      createdAt: session.createdAt.toISOString(),
    },
    items: rows.map((row) => {
      const answered = row.selectedIndex != null;
      const item: SessionItemView = {
        slotIndex: row.slotIndex,
        slotSource: row.slotSource,
        questionRevisionId: row.revisionId,
        era: row.era,
        topic: row.topic,
        difficulty: row.difficulty,
        prompt: row.prompt,
        choices: toChoices(row.choices),
        voided: row.status === 'voided',
        answered,
      };

      if (answered && row.selectedIndex != null && row.isCorrect != null) {
        item.selectedIndex = row.selectedIndex;
        item.isCorrect = row.isCorrect;
        item.correctIndex = row.correctIndex;
        item.explanation = row.explanation;
      }

      return item;
    }),
  };
}

/**
 * 오늘 세션 생성 또는 재사용 (08 §2 멱등).
 *
 * UNIQUE(user_id, study_date) 가 하루 한 세션을 보장한다.
 * 동시에 두 요청이 들어와도 하나만 INSERT 되고 나머지는 기존 세션을 그대로 받는다.
 */
export async function startTodaySession(userId: string, now: Date): Promise<SessionView> {
  const studyDate = toStudyDate(now);

  const [existing] = await db
    .select({ id: studySessions.id })
    .from(studySessions)
    .where(and(eq(studySessions.userId, userId), eq(studySessions.studyDate, studyDate)))
    .limit(1);

  if (existing != null) {
    return await loadSessionView(existing.id);
  }

  const [profile] = await db
    .select({ targetGrade: users.targetGrade, targetExamId: users.targetExamId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // 출제 후보는 published revision 뿐이다. retired/voided 는 제외된다 (08 §4).
  const poolRows = await db
    .select({
      canonicalQuestionId: questionRevisions.questionId,
      revisionId: questionRevisions.id,
      era: questionRevisions.era,
      topic: questionRevisions.topic,
      difficulty: questionRevisions.difficulty,
    })
    .from(questionRevisions)
    .where(eq(questionRevisions.status, 'published'));

  if (poolRows.length < SESSION_SIZE) {
    // 문항이 모자라면 반쪽 세션을 만들지 않는다. 운영 문제이므로 503 으로 알린다.
    throw new AppError('DEPENDENCY_UNAVAILABLE', {
      userMessage: '오늘의 문제를 준비하는 중이에요. 잠시 후 다시 시도해주세요.',
      details: { availableQuestions: poolRows.length, required: SESSION_SIZE },
    });
  }

  const stateRows = await db
    .select({
      canonicalQuestionId: userQuestionState.canonicalQuestionId,
      reviewDueAt: userQuestionState.reviewDueAt,
      lastSeenAt: userQuestionState.lastSeenAt,
    })
    .from(userQuestionState)
    .where(eq(userQuestionState.userId, userId));

  const masteryRows = await db
    .select({
      era: mastery.era,
      topic: mastery.topic,
      seenCount: mastery.seenCount,
      correctCount: mastery.correctCount,
    })
    .from(mastery)
    .where(eq(mastery.userId, userId));

  const selection = selectDailySet({
    // era/topic 은 DB 에서 text 로 오지만 CHECK 제약이 값 집합을 보장한다.
    pool: poolRows as PoolQuestion[],
    states: stateRows,
    mastery: masteryRows as MasterySnapshot[],
    targetGrade: profile?.targetGrade ?? null,
    now,
  });

  if (selection.length < SESSION_SIZE) {
    throw new AppError('DEPENDENCY_UNAVAILABLE', {
      userMessage: '오늘의 문제를 준비하는 중이에요. 잠시 후 다시 시도해주세요.',
      details: { selected: selection.length, required: SESSION_SIZE },
    });
  }

  try {
    const sessionId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(studySessions)
        .values({
          userId,
          studyDate,
          ...(profile?.targetExamId == null ? {} : { targetExamId: profile.targetExamId }),
        })
        .returning({ id: studySessions.id });

      if (created == null) throw new AppError('INTERNAL_ERROR');

      // 5행이 아니면 커밋 시점에 deferred 제약 트리거가 트랜잭션 전체를 되돌린다.
      await tx.insert(studySessionItems).values(
        selection.map((slot) => ({
          sessionId: created.id,
          questionRevisionId: slot.revisionId,
          canonicalQuestionId: slot.canonicalQuestionId,
          slotIndex: slot.slotIndex,
          slotSource: slot.slotSource,
        })),
      );

      return created.id;
    });

    return await loadSessionView(sessionId);
  } catch (error) {
    // 동시 요청이 먼저 세션을 만들었다면 그 세션을 그대로 쓴다.
    const [raced] = await db
      .select({ id: studySessions.id })
      .from(studySessions)
      .where(and(eq(studySessions.userId, userId), eq(studySessions.studyDate, studyDate)))
      .limit(1);

    if (raced != null) return await loadSessionView(raced.id);
    throw error;
  }
}

export interface AnswerResult {
  isCorrect: boolean;
  correctIndex: number;
  explanation: string;
  wrongAnswerNotes: unknown;
  memoryKeyword: string | null;
  answeredCount: number;
  validCount: number;
  /** 같은 답을 다시 보냈을 때 기존 판정을 그대로 돌려줬는지 */
  replayed: boolean;
}

/**
 * 답안 제출 (08 §2: 서버 판정, answer immutable).
 *
 * 연타로 같은 답이 두 번 오면 기존 판정을 그대로 돌려준다(중복 행을 만들지 않는다).
 * 같은 문항에 다른 답을 보내면 422 로 거부한다.
 */
export async function submitAnswer(
  userId: string,
  sessionId: string,
  questionRevisionId: string,
  selectedIndex: number,
  now: Date,
): Promise<AnswerResult> {
  const [session] = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.id, sessionId))
    .limit(1);

  if (session == null) throw new AppError('NOT_FOUND');
  // URL 의 id 를 신뢰하지 않는다. 내부 user_id 로 소유권을 판정한다 (공통 04 §2).
  if (session.userId !== userId) throw new AppError('NOT_FOUND');

  const studyDate = assertStudyDate(session.studyDate);
  if (!canCompleteSessionAt(studyDate, now)) {
    throw new AppError('STATE_CONFLICT', {
      userMessage: '이 세션은 마감됐어요. 오늘 문제를 새로 시작해주세요.',
    });
  }

  const [item] = await db
    .select({
      revisionId: questionRevisions.id,
      canonicalQuestionId: studySessionItems.canonicalQuestionId,
      correctIndex: questionRevisions.correctIndex,
      explanation: questionRevisions.explanation,
      wrongAnswerNotes: questionRevisions.wrongAnswerNotes,
      memoryKeyword: questionRevisions.memoryKeyword,
      status: questionRevisions.status,
    })
    .from(studySessionItems)
    .innerJoin(questionRevisions, eq(questionRevisions.id, studySessionItems.questionRevisionId))
    .where(
      and(
        eq(studySessionItems.sessionId, sessionId),
        eq(studySessionItems.questionRevisionId, questionRevisionId),
      ),
    )
    .limit(1);

  // 내 세션에 배정되지 않은 문항에는 답할 수 없다.
  if (item == null) throw new AppError('NOT_FOUND');

  const [existing] = await db
    .select({ selectedIndex: answers.selectedIndex, isCorrect: answers.isCorrect })
    .from(answers)
    .where(
      and(eq(answers.sessionId, sessionId), eq(answers.questionRevisionId, questionRevisionId)),
    )
    .limit(1);

  let isCorrect: boolean;
  let replayed = false;

  if (existing != null) {
    if (existing.selectedIndex !== selectedIndex) {
      // 08 §1: 제출 후 수정 금지.
      throw new AppError('ANSWER_ALREADY_SUBMITTED');
    }
    isCorrect = existing.isCorrect;
    replayed = true;
  } else {
    // 정답 판정은 서버가 한다. 클라이언트가 보낸 정답 여부를 받지 않는다.
    isCorrect = selectedIndex === item.correctIndex;

    try {
      // 답안 기록과 복습 상태 갱신은 같은 트랜잭션에서 이뤄져야 한다.
      // 답은 저장됐는데 복습 큐가 갱신되지 않으면 다음 날 복습 후보가 생기지 않는다.
      await db.transaction(async (tx) => {
        await tx.insert(answers).values({
          sessionId,
          questionRevisionId,
          selectedIndex,
          isCorrect,
        });

        await applyReviewState(tx, {
          userId,
          canonicalQuestionId: item.canonicalQuestionId,
          isCorrect,
          studyDate,
          answeredAt: now,
        });
      });
    } catch (error) {
      // 동시에 같은 답이 두 번 들어온 경우. 기존 판정을 그대로 쓴다.
      const [raced] = await db
        .select({ selectedIndex: answers.selectedIndex, isCorrect: answers.isCorrect })
        .from(answers)
        .where(
          and(eq(answers.sessionId, sessionId), eq(answers.questionRevisionId, questionRevisionId)),
        )
        .limit(1);

      if (raced == null) throw error;
      if (raced.selectedIndex !== selectedIndex) throw new AppError('ANSWER_ALREADY_SUBMITTED');
      isCorrect = raced.isCorrect;
      replayed = true;
    }
  }

  const progress = await countProgress(sessionId);

  return {
    isCorrect,
    correctIndex: item.correctIndex,
    explanation: item.explanation,
    wrongAnswerNotes: item.wrongAnswerNotes,
    memoryKeyword: item.memoryKeyword,
    answeredCount: progress.answeredValid,
    validCount: progress.valid,
    replayed,
  };
}

/**
 * 복습 상태 갱신 (07 §2, 08 §1).
 *
 * user_question_state 는 canonical question 기준이다.
 * 문항이 새 revision 으로 바뀌어도 사용자의 복습 상태는 그대로 이어진다.
 */
async function applyReviewState(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  params: {
    userId: string;
    canonicalQuestionId: string;
    isCorrect: boolean;
    studyDate: StudyDate;
    answeredAt: Date;
  },
): Promise<void> {
  const [current] = await tx
    .select({ intervalStep: userQuestionState.intervalStep })
    .from(userQuestionState)
    .where(
      and(
        eq(userQuestionState.userId, params.userId),
        eq(userQuestionState.canonicalQuestionId, params.canonicalQuestionId),
      ),
    )
    .limit(1);

  const next = nextReviewState(current?.intervalStep ?? null, params.isCorrect, params.studyDate);

  await tx
    .insert(userQuestionState)
    .values({
      userId: params.userId,
      canonicalQuestionId: params.canonicalQuestionId,
      intervalStep: next.intervalStep,
      reviewDueAt: next.reviewDueAt,
      lastResult: next.lastResult,
      lastSeenAt: params.answeredAt,
      wrongCount: params.isCorrect ? 0 : 1,
      correctCount: params.isCorrect ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [userQuestionState.userId, userQuestionState.canonicalQuestionId],
      set: {
        intervalStep: next.intervalStep,
        reviewDueAt: next.reviewDueAt,
        lastResult: next.lastResult,
        lastSeenAt: params.answeredAt,
        wrongCount: params.isCorrect
          ? userQuestionState.wrongCount
          : sql`${userQuestionState.wrongCount} + 1`,
        correctCount: params.isCorrect
          ? sql`${userQuestionState.correctCount} + 1`
          : userQuestionState.correctCount,
        updatedAt: params.answeredAt,
      },
    });
}

interface SessionProgress {
  /** voided 를 제외한 유효 문항 수 */
  valid: number;
  /** 유효 문항 중 답한 수 */
  answeredValid: number;
  /** 유효 문항 중 정답 수 */
  correctValid: number;
}

async function countProgress(sessionId: string): Promise<SessionProgress> {
  const rows = await db
    .select({
      status: questionRevisions.status,
      selectedIndex: answers.selectedIndex,
      isCorrect: answers.isCorrect,
    })
    .from(studySessionItems)
    .innerJoin(questionRevisions, eq(questionRevisions.id, studySessionItems.questionRevisionId))
    .leftJoin(
      answers,
      and(
        eq(answers.sessionId, studySessionItems.sessionId),
        eq(answers.questionRevisionId, studySessionItems.questionRevisionId),
      ),
    )
    .where(eq(studySessionItems.sessionId, sessionId));

  // 07 §9: void 문항은 집계에서 제외한다. 사용자의 실수로 취급하지 않는다.
  const valid = rows.filter((row) => row.status !== 'voided');

  return {
    valid: valid.length,
    answeredValid: valid.filter((row) => row.selectedIndex != null).length,
    correctValid: valid.filter((row) => row.isCorrect === true).length,
  };
}

export interface CompleteResult {
  session: { id: string; studyDate: StudyDate; score: number; completedAt: string };
  streak: { days: number; lastStreakDate: StudyDate };
  validCount: number;
  alreadyCompleted: boolean;
}

/**
 * 세션 완료 (08 §2: 유효 답안 기준 완료/streak/통계).
 *
 * void 로 유효 문항이 줄어도 학습 완료와 streak 는 유지한다 (07 §9, 09 §2).
 */
export async function completeSession(
  userId: string,
  sessionId: string,
  now: Date,
): Promise<CompleteResult> {
  const [session] = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.id, sessionId))
    .limit(1);

  if (session == null) throw new AppError('NOT_FOUND');
  if (session.userId !== userId) throw new AppError('NOT_FOUND');

  const studyDate = assertStudyDate(session.studyDate);

  const [profile] = await db
    .select({ streakDays: users.streakDays, lastStreakDate: users.lastStreakDate })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (session.completedAt != null) {
    // 재요청은 오류가 아니다. 같은 결과를 그대로 돌려준다.
    return {
      session: {
        id: session.id,
        studyDate,
        score: session.score ?? 0,
        completedAt: session.completedAt.toISOString(),
      },
      streak: {
        days: profile?.streakDays ?? 0,
        lastStreakDate: assertStudyDate(profile?.lastStreakDate ?? studyDate),
      },
      validCount: (await countProgress(sessionId)).valid,
      alreadyCompleted: true,
    };
  }

  if (!canCompleteSessionAt(studyDate, now)) {
    throw new AppError('STATE_CONFLICT', {
      userMessage: '이 세션은 마감됐어요. 오늘 문제를 새로 시작해주세요.',
    });
  }

  const progress = await countProgress(sessionId);

  if (progress.answeredValid < progress.valid) {
    throw new AppError('STATE_CONFLICT', {
      userMessage: '아직 풀지 않은 문제가 있어요.',
      details: { answered: progress.answeredValid, required: progress.valid },
    });
  }

  const completedAt = new Date();
  const streak = nextStreak(
    {
      streakDays: profile?.streakDays ?? 0,
      lastStreakDate:
        profile?.lastStreakDate == null ? null : assertStudyDate(profile.lastStreakDate),
    },
    studyDate,
  );

  await db.transaction(async (tx) => {
    await tx
      .update(studySessions)
      .set({ score: progress.correctValid, completedAt })
      .where(eq(studySessions.id, sessionId));

    await tx
      .update(users)
      .set({
        streakDays: streak.streakDays,
        ...(streak.lastStreakDate == null ? {} : { lastStreakDate: streak.lastStreakDate }),
        lastSeenAt: completedAt,
      })
      .where(eq(users.id, userId));
  });

  return {
    session: {
      id: session.id,
      studyDate,
      score: progress.correctValid,
      completedAt: completedAt.toISOString(),
    },
    streak: { days: streak.streakDays, lastStreakDate: streak.lastStreakDate ?? studyDate },
    validCount: progress.valid,
    alreadyCompleted: false,
  };
}
