import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { IDENTITY_STATUSES, sqlValueList } from './enums.ts';
import { examSchedules } from './exams.ts';

/**
 * 서비스 사용자.
 *
 * 근거: 공통 06 §2 (users/identity 최소 스키마), 03 §2, 09 §6
 * - anonKey 원문은 저장하지 않는다. 조회는 HMAC fingerprint, 재사용이 필요할 때만 AEAD 암호문.
 * - 삭제는 soft(deleted) 로 끝내지 않고 deletion_jobs 를 통해 실제 파기까지 간다 (공통 04 §5).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** HMAC-SHA256(server_pepper, anonKey). 원문 대신 이 값으로만 조회한다. */
    anonKeyFingerprint: text('anon_key_fingerprint').notNull(),
    /**
     * fingerprint 를 계산한 pepper 버전.
     *
     * pepper 를 회전하면 기존 fingerprint 를 재계산할 수 없다(anonKey 원문을 보관하지 않기 때문).
     * 대신 bootstrap 요청에는 원문이 들어오므로, 구 버전으로 조회되면
     * 그 자리에서 현재 버전 fingerprint 로 갱신해 자연스럽게 마이그레이션한다.
     */
    anonKeyFingerprintVersion: integer('anon_key_fingerprint_version').notNull().default(1),
    /** 스마트 발송에 anonKey 원문이 필요할 때만 AEAD 암호문으로 보관한다. */
    anonKeyCiphertext: text('anon_key_ciphertext'),
    anonKeyKeyVersion: integer('anon_key_key_version'),

    identityStatus: text('identity_status').notNull().default('active'),
    identityVerifiedAt: timestamp('identity_verified_at', { withTimezone: true }),

    /** 목표 심화 급수 1/2/3 (07 §1: V1 은 심화만 다룬다) */
    targetGrade: integer('target_grade'),
    targetExamId: uuid('target_exam_id').references(() => examSchedules.id, {
      onDelete: 'set null',
    }),

    /** 연속 학습일. 판정 규칙은 로직 단계에서 확정한다 (AGENTS.md §9 #4). */
    streakDays: integer('streak_days').notNull().default(0),
    lastStreakDate: date('last_streak_date'),

    /** 문제 재현용 클라이언트 버전 (공통 02 §3) */
    appVersion: text('app_version'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** soft delete 시각. 실제 파기는 deletion_jobs 가 수행한다. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_anon_key_fingerprint_key').on(t.anonKeyFingerprint),
    index('users_identity_status_idx').on(t.identityStatus),
    index('users_target_exam_idx').on(t.targetExamId),
    check(
      'users_identity_status_check',
      sql`${t.identityStatus} in (${sql.raw(sqlValueList(IDENTITY_STATUSES))})`,
    ),
    check(
      'users_target_grade_check',
      sql`${t.targetGrade} is null or ${t.targetGrade} between 1 and 3`,
    ),
    check('users_streak_days_check', sql`${t.streakDays} >= 0`),
    check('users_anon_key_fingerprint_version_check', sql`${t.anonKeyFingerprintVersion} >= 1`),
    // 암호문과 키 버전은 항상 함께 존재해야 복호화가 가능하다.
    check(
      'users_anon_key_ciphertext_pair_check',
      sql`(${t.anonKeyCiphertext} is null) = (${t.anonKeyKeyVersion} is null)`,
    ),
    check(
      'users_deleted_at_check',
      sql`(${t.identityStatus} = 'deleted') = (${t.deletedAt} is not null)`,
    ),
  ],
);
