import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ANSWER_RESULTS, ERAS, SLOT_SOURCES, TOPICS, sqlValueList } from './enums.ts';
import { questionRevisions, questions } from './content.ts';
import { examSchedules } from './exams.ts';
import { users } from './identity.ts';

/**
 * 오늘의 학습 세션 (08 §1, 09 §1).
 *
 * - study_date 는 서버 Asia/Seoul 기준 달력 날짜다. 시각이 아니라 date 타입을 쓴다.
 * - UNIQUE(user_id, study_date) 가 "하루 한 세션"을 DB 레벨에서 보장한다.
 *   동시 요청이 들어와도 두 번째 INSERT 가 거부되므로 멱등 처리가 가능하다.
 * - 세트 5개는 study_session_items 에 고정된다.
 */
export const studySessions = pgTable(
  'study_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** KST 달력 날짜 (09 §1) */
    studyDate: date('study_date').notNull(),
    /** 세션 생성 시점의 목표 회차. 이후 목표를 바꿔도 과거 세션은 그대로 남는다 (08 §2). */
    targetExamId: uuid('target_exam_id').references(() => examSchedules.id, {
      onDelete: 'set null',
    }),
    /** 완료 시 확정되는 정답 수. void 문항 제외 후 유효 답안 기준 (07 §9). */
    score: integer('score'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('study_sessions_user_date_key').on(t.userId, t.studyDate),
    index('study_sessions_completed_idx').on(t.completedAt),
    check('study_sessions_score_check', sql`${t.score} is null or ${t.score} between 0 and 5`),
    /** 완료 시각과 점수는 함께 확정된다. */
    check(
      'study_sessions_completion_pair_check',
      sql`(${t.completedAt} is null) = (${t.score} is null)`,
    ),
  ],
);

/**
 * 세션에 고정된 5개 문항 슬롯.
 *
 * 08 §1 의 "question_revision_ids 5개 고정"을 배열 컬럼 대신 관계로 구현한다.
 * 배열은 FK 를 걸 수 없어서 없는 revision 을 가리켜도 DB 가 막지 못한다.
 * 여기서는 FK + slot_index UNIQUE + 개수 검사 트리거로 같은 계약을 더 강하게 보장한다.
 *
 * slot_source 는 07 §2 의 슬롯 구성(복습 2 + 취약 1 + 신규 2)을 기록해 스케줄러 검증에 쓴다.
 */
export const studySessionItems = pgTable(
  'study_session_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => studySessions.id, { onDelete: 'cascade' }),
    questionRevisionId: uuid('question_revision_id')
      .notNull()
      .references(() => questionRevisions.id, { onDelete: 'restrict' }),
    /** 복습 상태 갱신용. revision 이 바뀌어도 같은 문항으로 이어진다. */
    canonicalQuestionId: uuid('canonical_question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    slotIndex: integer('slot_index').notNull(),
    slotSource: text('slot_source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('study_session_items_slot_key').on(t.sessionId, t.slotIndex),
    /**
     * 같은 세션에 같은 문항이 두 번 들어가지 않는다.
     * answers 의 복합 FK 대상이므로 인덱스가 아니라 UNIQUE 제약으로 만든다.
     * (인덱스는 테이블 생성 이후에 만들어져 FK 추가 시점에 존재하지 않는다)
     */
    unique('study_session_items_revision_key').on(t.sessionId, t.questionRevisionId),
    index('study_session_items_revision_idx').on(t.questionRevisionId),
    check('study_session_items_slot_index_check', sql`${t.slotIndex} between 0 and 4`),
    check(
      'study_session_items_slot_source_check',
      sql`${t.slotSource} in (${sql.raw(sqlValueList(SLOT_SOURCES))})`,
    ),
  ],
);

/**
 * 답안 (08 §1).
 *
 * - UNIQUE(session_id, question_revision_id) 로 한 문항에 한 번만 답할 수 있다.
 * - 제출 후 수정 금지. UPDATE 는 DB 트리거가 막는다(0001 migration).
 * - 정답 여부는 서버가 판정해 저장한다. 클라이언트 값을 그대로 신뢰하지 않는다 (공통 02 §4).
 * - 복합 FK 로 "내 세션에 배정된 문항"에만 답할 수 있게 강제한다.
 */
export const answers = pgTable(
  'answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => studySessions.id, { onDelete: 'cascade' }),
    questionRevisionId: uuid('question_revision_id')
      .notNull()
      .references(() => questionRevisions.id, { onDelete: 'restrict' }),
    selectedIndex: integer('selected_index').notNull(),
    isCorrect: boolean('is_correct').notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('answers_session_revision_key').on(t.sessionId, t.questionRevisionId),
    foreignKey({
      name: 'answers_session_item_fk',
      columns: [t.sessionId, t.questionRevisionId],
      foreignColumns: [studySessionItems.sessionId, studySessionItems.questionRevisionId],
    }).onDelete('cascade'),
    check('answers_selected_index_check', sql`${t.selectedIndex} between 0 and 4`),
  ],
);

/**
 * 문항별 복습 상태 (08 §1).
 *
 * 07 §2 복습 간격: 오답 후 1일 -> 정답 3일 -> 정답 7일. 재오답 시 1일로 되돌린다.
 * interval_step 은 단계 번호만 저장하고, 7일 이후 정책은 로직 단계에서 확정한다(AGENTS.md §9 #5).
 */
export const userQuestionState = pgTable(
  'user_question_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canonicalQuestionId: uuid('canonical_question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    /** 복습 예정 시각. 이 시각이 지난 문항이 복습 슬롯 후보다. */
    reviewDueAt: timestamp('review_due_at', { withTimezone: true }),
    /** 0=미설정, 1=1일, 2=3일, 3=7일 */
    intervalStep: integer('interval_step').notNull().default(0),
    lastResult: text('last_result').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }),
    wrongCount: integer('wrong_count').notNull().default(0),
    correctCount: integer('correct_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.canonicalQuestionId] }),
    /** 복습 큐 조회: 기한이 지난 문항을 오래된 순으로 (07 §2 슬롯 1) */
    index('user_question_state_due_idx').on(t.userId, t.reviewDueAt),
    check(
      'user_question_state_last_result_check',
      sql`${t.lastResult} in (${sql.raw(sqlValueList(ANSWER_RESULTS))})`,
    ),
    check('user_question_state_interval_step_check', sql`${t.intervalStep} between 0 and 3`),
    check('user_question_state_counts_check', sql`${t.wrongCount} >= 0 and ${t.correctCount} >= 0`),
    /** 최근 30일 재노출 최소화(09 §5)를 위한 조회 */
    index('user_question_state_last_seen_idx').on(t.userId, t.lastSeenAt),
  ],
);

/**
 * 시대×주제 숙련도 (03 §2, 07 §3).
 *
 * - seen_count < 5 면 화면에 퍼센트를 보여주지 않는다("데이터 부족"). 판단은 조회 계층에서 한다.
 * - smoothed_accuracy = (correct_count + 2) / (seen_count + 4) 는 컬럼으로 저장하지 않고
 *   식 인덱스로 조회를 지원한다(0001 migration). 저장하면 재계산 시 정합성이 두 곳으로 갈린다.
 * - void 문항은 집계에서 제외하고 재계산한다 (07 §9). recalculated_at 이 마지막 재계산 시각이다.
 */
export const mastery = pgTable(
  'mastery',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    era: text('era').notNull(),
    topic: text('topic').notNull(),
    seenCount: integer('seen_count').notNull().default(0),
    correctCount: integer('correct_count').notNull().default(0),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    recalculatedAt: timestamp('recalculated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.era, t.topic] }),
    check('mastery_era_check', sql`${t.era} in (${sql.raw(sqlValueList(ERAS))})`),
    check('mastery_topic_check', sql`${t.topic} in (${sql.raw(sqlValueList(TOPICS))})`),
    check(
      'mastery_counts_check',
      sql`${t.seenCount} >= 0 and ${t.correctCount} >= 0 and ${t.correctCount} <= ${t.seenCount}`,
    ),
  ],
);
