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
import { EXAM_STATUSES, EXAM_TYPES, sqlValueList } from './enums.ts';

/**
 * 공식 시험 일정 (08 §1, 09 §3).
 *
 * - D-day 는 이 테이블 데이터만 사용한다. 앱 번들에 날짜를 하드코딩하지 않는다.
 * - 회차는 UNIQUE 이며 종류(advanced/basic)별로 번호가 매겨진다.
 * - source_url / source_verified_at 로 어떤 공식 자료에서 확인했는지 추적한다.
 * - 변경 내역은 exam_schedule_audits 에 보존한다.
 */
export const examSchedules = pgTable(
  'exam_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    round: integer('round').notNull(),
    examDate: date('exam_date').notNull(),
    status: text('status').notNull().default('scheduled'),
    /** 공식 근거 URL. 없이는 등록할 수 없다. */
    sourceUrl: text('source_url').notNull(),
    /** 운영자가 실제로 공식 자료를 확인한 시각. */
    sourceVerifiedAt: timestamp('source_verified_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('exam_schedules_type_round_key').on(t.type, t.round),
    index('exam_schedules_exam_date_idx').on(t.examDate),
    index('exam_schedules_status_date_idx').on(t.status, t.examDate),
    check('exam_schedules_type_check', sql`${t.type} in (${sql.raw(sqlValueList(EXAM_TYPES))})`),
    check(
      'exam_schedules_status_check',
      sql`${t.status} in (${sql.raw(sqlValueList(EXAM_STATUSES))})`,
    ),
    check('exam_schedules_round_check', sql`${t.round} > 0`),
    check('exam_schedules_source_url_check', sql`length(${t.sourceUrl}) > 0`),
  ],
);

/**
 * 시험 일정 변경 로그 (08 §1 "변경 로그 보존", 09 §6).
 *
 * 개인 데이터와 분리된 운영 기록이라 사용자 삭제와 무관하게 보존한다.
 * 일정 행 자체는 감사 기록이 있는 한 삭제할 수 없다(ON DELETE RESTRICT).
 */
export const examScheduleAudits = pgTable(
  'exam_schedule_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    examScheduleId: uuid('exam_schedule_id')
      .notNull()
      .references(() => examSchedules.id, { onDelete: 'restrict' }),
    changedBy: uuid('changed_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    changeReason: text('change_reason').notNull(),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state').notNull(),
    /** 변경 근거로 확인한 공식 자료. */
    sourceUrl: text('source_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('exam_schedule_audits_schedule_idx').on(t.examScheduleId, t.createdAt),
    check('exam_schedule_audits_reason_check', sql`length(${t.changeReason}) > 0`),
  ],
);
