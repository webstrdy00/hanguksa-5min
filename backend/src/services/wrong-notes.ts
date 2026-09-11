import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { questionRevisions } from '../db/schema/content.ts';
import {
  answers,
  studySessionItems,
  studySessions,
  userQuestionState,
} from '../db/schema/learning.ts';
import { isReviewed } from '../domain/review-schedule.ts';
import { AppError } from '../http/errors.ts';

/**
 * 오답노트 (03 §3, 02 UX).
 *
 * 사용자가 **실제로 푼 revision** 을 보여준다. 문항이 수정돼도 그때 본 내용 그대로 재현된다 (09 §2).
 * voided 문항은 목록에서 제외한다. 잘못된 내용을 다시 학습시키지 않기 위해서다 (07 §9).
 * retired 문항은 내용 자체는 유효하므로 남기되 새 세션에 나오지 않는다는 표시를 준다.
 */

export interface WrongNoteItem {
  canonicalQuestionId: string;
  questionRevisionId: string;
  era: string;
  topic: string;
  difficulty: number;
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  memoryKeyword: string | null;
  /** 사용자가 마지막으로 고른 선택지 */
  selectedIndex: number;
  wrongCount: number;
  intervalStep: number;
  reviewDueAt: string | null;
  lastSeenAt: string;
  lastReviewedAt: string | null;
  reviewed: boolean;
  /** 더 이상 새 세션에 출제되지 않는 문항 */
  retired: boolean;
}

export interface WrongNoteQuery {
  era?: string | undefined;
  /** unreviewed | reviewed | all */
  status: 'unreviewed' | 'reviewed' | 'all';
  page: number;
  limit: number;
}

function toChoices(value: unknown): string[] {
  return Array.isArray(value) ? value.map((choice) => String(choice)) : [];
}

/** 사용자가 각 문항을 마지막으로 푼 revision 과 선택지를 찾는다. */
async function loadLastAnswered(
  userId: string,
  canonicalIds: string[],
): Promise<Map<string, { revisionId: string; selectedIndex: number }>> {
  if (canonicalIds.length === 0) return new Map();

  const rows = await db
    .selectDistinctOn([studySessionItems.canonicalQuestionId], {
      canonicalQuestionId: studySessionItems.canonicalQuestionId,
      revisionId: answers.questionRevisionId,
      selectedIndex: answers.selectedIndex,
    })
    .from(answers)
    .innerJoin(
      studySessionItems,
      and(
        eq(studySessionItems.sessionId, answers.sessionId),
        eq(studySessionItems.questionRevisionId, answers.questionRevisionId),
      ),
    )
    .innerJoin(studySessions, eq(studySessions.id, answers.sessionId))
    .where(
      and(
        eq(studySessions.userId, userId),
        inArray(studySessionItems.canonicalQuestionId, canonicalIds),
      ),
    )
    .orderBy(studySessionItems.canonicalQuestionId, desc(answers.answeredAt));

  return new Map(
    rows.map((row) => [
      row.canonicalQuestionId,
      { revisionId: row.revisionId, selectedIndex: row.selectedIndex },
    ]),
  );
}

export interface WrongNoteList {
  items: WrongNoteItem[];
  page: number;
  limit: number;
  total: number;
}

export async function listWrongNotes(
  userId: string,
  query: WrongNoteQuery,
): Promise<WrongNoteList> {
  // 마지막 결과가 오답인 문항만 오답노트에 올린다.
  const baseWhere = and(
    eq(userQuestionState.userId, userId),
    eq(userQuestionState.lastResult, 'wrong'),
  );

  const stateRows = await db
    .select({
      canonicalQuestionId: userQuestionState.canonicalQuestionId,
      intervalStep: userQuestionState.intervalStep,
      reviewDueAt: userQuestionState.reviewDueAt,
      lastSeenAt: userQuestionState.lastSeenAt,
      lastReviewedAt: userQuestionState.lastReviewedAt,
      wrongCount: userQuestionState.wrongCount,
    })
    .from(userQuestionState)
    .where(baseWhere)
    .orderBy(desc(userQuestionState.lastSeenAt));

  const lastAnswered = await loadLastAnswered(
    userId,
    stateRows.map((row) => row.canonicalQuestionId),
  );

  const revisionIds = [...lastAnswered.values()].map((entry) => entry.revisionId);

  const revisions =
    revisionIds.length === 0
      ? []
      : await db
          .select({
            id: questionRevisions.id,
            era: questionRevisions.era,
            topic: questionRevisions.topic,
            difficulty: questionRevisions.difficulty,
            prompt: questionRevisions.prompt,
            choices: questionRevisions.choices,
            correctIndex: questionRevisions.correctIndex,
            explanation: questionRevisions.explanation,
            memoryKeyword: questionRevisions.memoryKeyword,
            status: questionRevisions.status,
          })
          .from(questionRevisions)
          .where(inArray(questionRevisions.id, revisionIds));

  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));

  const all: WrongNoteItem[] = [];

  for (const state of stateRows) {
    const answered = lastAnswered.get(state.canonicalQuestionId);
    if (answered == null) continue;

    const revision = revisionById.get(answered.revisionId);
    if (revision == null) continue;

    // 07 §9: void 된 문항은 사용자에게 다시 학습시키지 않는다.
    if (revision.status === 'voided') continue;

    const reviewed = isReviewed(state.lastSeenAt, state.lastReviewedAt);

    if (query.status === 'reviewed' && !reviewed) continue;
    if (query.status === 'unreviewed' && reviewed) continue;
    if (query.era != null && revision.era !== query.era) continue;

    all.push({
      canonicalQuestionId: state.canonicalQuestionId,
      questionRevisionId: revision.id,
      era: revision.era,
      topic: revision.topic,
      difficulty: revision.difficulty,
      prompt: revision.prompt,
      choices: toChoices(revision.choices),
      correctIndex: revision.correctIndex,
      explanation: revision.explanation,
      memoryKeyword: revision.memoryKeyword,
      selectedIndex: answered.selectedIndex,
      wrongCount: state.wrongCount,
      intervalStep: state.intervalStep,
      reviewDueAt: state.reviewDueAt?.toISOString() ?? null,
      lastSeenAt: state.lastSeenAt.toISOString(),
      lastReviewedAt: state.lastReviewedAt?.toISOString() ?? null,
      reviewed,
      retired: revision.status === 'retired',
    });
  }

  const offset = (query.page - 1) * query.limit;

  return {
    items: all.slice(offset, offset + query.limit),
    page: query.page,
    limit: query.limit,
    total: all.length,
  };
}

export interface ReviewResult {
  canonicalQuestionId: string;
  lastReviewedAt: string;
  reviewed: boolean;
  /** 복습 간격은 바뀌지 않는다는 것을 클라이언트에 명시한다. */
  reviewDueAt: string | null;
  intervalStep: number;
}

/**
 * 오답노트 복습 기록 (03 §3).
 *
 * AGENTS.md §9 #6 (2026-08-17 확정): last_reviewed_at 만 기록한다.
 * review_due_at / interval_step / mastery 는 건드리지 않는다.
 * 정답 판정이 없는 자율 열람이라 이걸로 간격을 전진시키면 실제 재출제 기회를 잃는다.
 *
 * 여러 번 호출해도 결과가 같도록 마지막 시각만 갱신한다.
 */
export async function recordReview(
  userId: string,
  canonicalQuestionId: string,
  now: Date,
): Promise<ReviewResult> {
  const [state] = await db
    .select()
    .from(userQuestionState)
    .where(
      and(
        eq(userQuestionState.userId, userId),
        eq(userQuestionState.canonicalQuestionId, canonicalQuestionId),
      ),
    )
    .limit(1);

  if (state == null) throw new AppError('NOT_FOUND');

  // 오답 상태가 아닌 문항은 오답노트에 없다.
  if (state.lastResult !== 'wrong') throw new AppError('NOT_FOUND');

  const [updated] = await db
    .update(userQuestionState)
    .set({ lastReviewedAt: now })
    .where(
      and(
        eq(userQuestionState.userId, userId),
        eq(userQuestionState.canonicalQuestionId, canonicalQuestionId),
      ),
    )
    .returning({
      lastReviewedAt: userQuestionState.lastReviewedAt,
      lastSeenAt: userQuestionState.lastSeenAt,
      reviewDueAt: userQuestionState.reviewDueAt,
      intervalStep: userQuestionState.intervalStep,
    });

  if (updated == null) throw new AppError('INTERNAL_ERROR');

  return {
    canonicalQuestionId,
    lastReviewedAt: (updated.lastReviewedAt ?? now).toISOString(),
    reviewed: isReviewed(updated.lastSeenAt, updated.lastReviewedAt),
    reviewDueAt: updated.reviewDueAt?.toISOString() ?? null,
    intervalStep: updated.intervalStep,
  };
}

/** 오답노트 요약. 홈 화면에서 미복습 개수를 보여줄 때 쓴다. */
export async function countUnreviewed(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(userQuestionState)
    .where(and(eq(userQuestionState.userId, userId), eq(userQuestionState.lastResult, 'wrong')));

  return Number(row?.value ?? 0);
}
