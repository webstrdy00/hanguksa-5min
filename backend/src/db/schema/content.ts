import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import {
  ABILITIES,
  ERAS,
  NOTICE_TYPES,
  QUESTION_STATUSES,
  REPORT_REASONS,
  REPORT_STATUSES,
  RIGHTS_TYPES,
  TOPICS,
  sqlValueList,
} from './enums.ts';
import { users } from './identity.ts';

/**
 * 문항의 논리적 정체성(canonical question).
 *
 * 내용은 전부 question_revisions 에 있다. 이 테이블은 "같은 문항"이라는 사실만 유지한다.
 * user_question_state 가 이 id 를 참조하기 때문에, 문항 내용이 새 revision 으로 바뀌어도
 * 사용자의 복습 상태는 그대로 이어진다 (08 §1).
 */
export const questions = pgTable(
  'questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [],
);

/**
 * 문항 revision (08 §1, 09 §2).
 *
 * 핵심 불변식: **published revision 의 내용은 immutable 이다.**
 * 수정은 덮어쓰기가 아니라 새 revision 발행으로만 한다. 과거 세션이 그대로 재현되어야 하기 때문이다.
 * 내용 컬럼 UPDATE 는 DB 트리거가 막는다(0001 migration).
 *
 * 분류(era/topic/ability/difficulty)도 revision 에 둔다.
 * 시대 태그가 잘못돼 고치는 것도 내용 변경이고, 과거 결과는 사용자가 실제로 본 태그로 재현되어야 한다.
 */
export const questionRevisions = pgTable(
  'question_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    status: text('status').notNull().default('draft'),

    // 분류 (04 §2)
    era: text('era').notNull(),
    topic: text('topic').notNull(),
    ability: text('ability').notNull(),
    difficulty: integer('difficulty').notNull(),

    // 문항 본문. 실제 심화 시험을 반영해 5지 선택형이다 (02 UX).
    prompt: text('prompt').notNull(),
    choices: jsonb('choices').notNull(),
    correctIndex: integer('correct_index').notNull(),

    // 해설: 정답 근거 -> 오답 핵심 -> 기억 키워드 (02 UX)
    explanation: text('explanation').notNull(),
    wrongAnswerNotes: jsonb('wrong_answer_notes'),
    memoryKeyword: text('memory_keyword'),

    // 출처/권리/검수 (07 §5). published 는 아래 CHECK 로 필수값을 강제한다.
    sourceRefs: jsonb('source_refs')
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourceAccessedAt: date('source_accessed_at'),
    rightsType: text('rights_type').notNull().default('unknown'),
    rightsNote: text('rights_note'),
    reviewerId: uuid('reviewer_id').references(() => adminUsers.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

    /** AI 초안 사용 시 모델/프롬프트 버전과 생성 시각 (07 §5, 운영용) */
    aiGenerationMeta: jsonb('ai_generation_meta'),

    /** voided/retired 로 내린 사유. 상태 전이는 허용되지만 내용은 불변이다. */
    statusReason: text('status_reason'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),

    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    // immutable 테이블이라 updated_at 을 두지 않는다.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('question_revisions_question_revision_key').on(t.questionId, t.revision),
    /** 한 문항에 published revision 은 최대 1개다. */
    uniqueIndex('question_revisions_one_published_idx')
      .on(t.questionId)
      .where(sql`status = 'published'`),
    /** 출제 후보 조회: 시대/주제 커버리지 기준 (07 §2 슬롯 3) */
    index('question_revisions_pool_idx')
      .on(t.era, t.topic, t.difficulty)
      .where(sql`status = 'published'`),
    index('question_revisions_status_idx').on(t.status),

    check(
      'question_revisions_status_check',
      sql`${t.status} in (${sql.raw(sqlValueList(QUESTION_STATUSES))})`,
    ),
    check('question_revisions_era_check', sql`${t.era} in (${sql.raw(sqlValueList(ERAS))})`),
    check('question_revisions_topic_check', sql`${t.topic} in (${sql.raw(sqlValueList(TOPICS))})`),
    check(
      'question_revisions_ability_check',
      sql`${t.ability} in (${sql.raw(sqlValueList(ABILITIES))})`,
    ),
    check(
      'question_revisions_rights_type_check',
      sql`${t.rightsType} in (${sql.raw(sqlValueList(RIGHTS_TYPES))})`,
    ),
    check('question_revisions_revision_check', sql`${t.revision} >= 1`),
    check('question_revisions_difficulty_check', sql`${t.difficulty} between 1 and 3`),
    /** 5지 선택형 */
    check('question_revisions_choices_check', sql`jsonb_array_length(${t.choices}) = 5`),
    check('question_revisions_correct_index_check', sql`${t.correctIndex} between 0 and 4`),
    check('question_revisions_prompt_check', sql`length(${t.prompt}) > 0`),
    check('question_revisions_explanation_check', sql`length(${t.explanation}) > 0`),
    /**
     * 08 §1: published 는 source_refs / reviewer_id / rights 가 필수다.
     * 07 §4 콘텐츠 게이트를 DB 레벨에서 강제한다. 메타 없이는 publish 자체가 불가능하다.
     */
    check(
      'question_revisions_publish_requirements_check',
      sql`${t.status} <> 'published' or (
        jsonb_array_length(${t.sourceRefs}) > 0
        and ${t.sourceAccessedAt} is not null
        and ${t.reviewerId} is not null
        and ${t.reviewedAt} is not null
        and ${t.rightsType} <> 'unknown'
      )`,
    ),
  ],
);

/**
 * 문항 오류 제보 (08 §2, 06 백로그 P0).
 *
 * 08 §2: "원문 사용자 답안 불필요". 사용자가 무엇을 골랐는지는 저장하지 않는다.
 * 사용자 삭제 시 user_id 와 detail(사용자 작성 텍스트)은 지우고, 사유/상태는 콘텐츠 품질 데이터로 남긴다.
 */
export const questionReports = pgTable(
  'question_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionRevisionId: uuid('question_revision_id')
      .notNull()
      .references(() => questionRevisions.id, { onDelete: 'restrict' }),
    reporterUserId: uuid('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    /** 사용자가 직접 쓴 보충 설명(UGC). 계정 삭제 시 함께 지운다. */
    detail: text('detail'),
    status: text('status').notNull().default('open'),
    resolvedBy: uuid('resolved_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('question_reports_triage_idx').on(t.status, t.createdAt),
    index('question_reports_revision_idx').on(t.questionRevisionId),
    check(
      'question_reports_reason_check',
      sql`${t.reason} in (${sql.raw(sqlValueList(REPORT_REASONS))})`,
    ),
    check(
      'question_reports_status_check',
      sql`${t.status} in (${sql.raw(sqlValueList(REPORT_STATUSES))})`,
    ),
    check(
      'question_reports_detail_length_check',
      sql`${t.detail} is null or length(${t.detail}) <= 500`,
    ),
    check(
      'question_reports_resolved_pair_check',
      sql`(${t.status} in ('resolved', 'rejected')) = (${t.resolvedAt} is not null)`,
    ),
  ],
);

/**
 * 정정 안내 (07 §9).
 * 사용자에게 과거 문항 수정 사실을 알려야 할 때 기록하고 앱 내 공지/해설 수정 내역으로 노출한다.
 */
export const correctionNotices = pgTable(
  'correction_notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    fromRevisionId: uuid('from_revision_id').references(() => questionRevisions.id, {
      onDelete: 'restrict',
    }),
    toRevisionId: uuid('to_revision_id').references(() => questionRevisions.id, {
      onDelete: 'restrict',
    }),
    noticeType: text('notice_type').notNull(),
    /** 사용자에게 보여줄 문구. 불안 자극/합격 보장 표현 금지 (07 §7). */
    message: text('message').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('correction_notices_question_idx').on(t.questionId, t.createdAt),
    index('correction_notices_published_idx').on(t.publishedAt),
    check(
      'correction_notices_type_check',
      sql`${t.noticeType} in (${sql.raw(sqlValueList(NOTICE_TYPES))})`,
    ),
    check('correction_notices_message_check', sql`length(${t.message}) > 0`),
  ],
);
