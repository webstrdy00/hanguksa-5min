import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
import { questionRevisions } from './content.ts';
import {
  DELETION_STATUSES,
  RECALC_REASONS,
  RECALC_STATUSES,
  IDEMPOTENCY_STATES,
  PUSH_TARGET_STATUSES,
  SEND_STATUSES,
  sqlValueList,
} from './enums.ts';
import { users } from './identity.ts';

/** 복원본의 계보와 원장 재적용 위치. 외부 원장과 일치하지 않으면 기동하지 않는다. */
export const deletionRestoreState = pgTable(
  'deletion_restore_state',
  {
    id: integer('id').primaryKey().default(1),
    datasetId: uuid('dataset_id').notNull().defaultRandom(),
    replayedOrdinal: integer('replayed_ordinal').notNull().default(0),
    journalEnforced: boolean('journal_enforced').notNull().default(false),
  },
  (t) => [
    check('deletion_restore_state_singleton', sql`${t.id} = 1`),
    check('deletion_restore_state_ordinal', sql`${t.replayedOrdinal} >= 0`),
  ],
);

/**
 * 알림 동의 상태 (공통 01 §4, 공통 02 §3, 07 §7).
 *
 * 기능성 알림("오늘 5문제")과 광고성 스마트 발송을 분리해서 관리한다.
 * 동의 없이 발송하지 않으며, 마지막 발송 결과를 서버가 관리한다.
 */
export const notificationConsents = pgTable(
  'notification_consents',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    functionalAgreed: boolean('functional_agreed').notNull().default(false),
    functionalAgreedAt: timestamp('functional_agreed_at', { withTimezone: true }),
    marketingAgreed: boolean('marketing_agreed').notNull().default(false),
    marketingAgreedAt: timestamp('marketing_agreed_at', { withTimezone: true }),
    pushTargetStatus: text('push_target_status').notNull().default('unknown'),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    lastSendStatus: text('last_send_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notification_consents_functional_idx')
      .on(t.pushTargetStatus)
      .where(sql`functional_agreed = true`),
    /** 동의 상태와 동의 시각은 항상 함께 기록한다. 동의 시점 증빙이 필요하다. */
    check(
      'notification_consents_functional_pair_check',
      sql`${t.functionalAgreed} = false or ${t.functionalAgreedAt} is not null`,
    ),
    check(
      'notification_consents_marketing_pair_check',
      sql`${t.marketingAgreed} = false or ${t.marketingAgreedAt} is not null`,
    ),
    check(
      'notification_consents_push_target_check',
      sql`${t.pushTargetStatus} in (${sql.raw(sqlValueList(PUSH_TARGET_STATUSES))})`,
    ),
    check(
      'notification_consents_send_status_check',
      sql`${t.lastSendStatus} is null or ${t.lastSendStatus} in (${sql.raw(sqlValueList(SEND_STATUSES))})`,
    ),
  ],
);

/**
 * 멱등 키 (공통 05 §2, 공통 04 §2).
 *
 * 버튼 연타/네트워크 재시도에도 논리 작업이 한 번만 생성되게 한다.
 * 하드게이트 §2 내부 권장 보관: 24시간 이상. expires_at 이후 purge 배치가 정리한다.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * 유일성 판단 키. `user:<uuid>` 또는 `admin:<uuid>` 형식이다.
     * FK 로 나눠 두면 NULL 이 UNIQUE 충돌을 피해가므로 단일 문자열 키를 따로 둔다.
     */
    actorKey: text('actor_key').notNull(),
    /** 사용자 삭제 시 함께 지워지도록 FK 를 유지한다 (09 §6). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    adminUserId: uuid('admin_user_id').references(() => adminUsers.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    endpoint: text('endpoint').notNull(),
    /** 같은 키로 다른 본문이 오면 충돌로 처리하기 위한 해시. 본문 원문은 저장하지 않는다. */
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull().default('in_progress'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_scope_key').on(t.actorKey, t.endpoint, t.idempotencyKey),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
    /** 사용자와 관리자 중 정확히 하나만 가리킨다. */
    check(
      'idempotency_keys_actor_check',
      sql`(${t.userId} is not null) <> (${t.adminUserId} is not null)`,
    ),
    check(
      'idempotency_keys_state_check',
      sql`${t.state} in (${sql.raw(sqlValueList(IDEMPOTENCY_STATES))})`,
    ),
    check(
      'idempotency_keys_completed_check',
      sql`${t.state} <> 'completed' or ${t.responseStatus} is not null`,
    ),
  ],
);

/**
 * 계정/데이터 삭제 작업 (공통 04 §5, 하드게이트 DB/운영 P0).
 *
 * UI 에서 삭제 버튼을 눌렀다고 완료로 치지 않는다.
 * DB -> cache -> push target -> 파생 데이터 -> 백업 소거 주기까지 단계별로 추적한다.
 *
 * users 행이 실제로 파기된 뒤에도 "삭제를 이행했다"는 증적이 남아야 하므로
 * subject_user_id 에는 FK 를 걸지 않는다. 매핑이 모두 사라진 uuid 단독으로는 개인을 식별할 수 없다.
 */
export const deletionJobs = pgTable(
  'deletion_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectUserId: uuid('subject_user_id').notNull(),
    status: text('status').notNull().default('requested'),
    /** 단계별 이행 기록: db / cache / push_target / derived / backup */
    steps: jsonb('steps')
      .notNull()
      .default(sql`'[]'::jsonb`),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deletion_jobs_status_idx').on(t.status, t.requestedAt),
    index('deletion_jobs_subject_idx').on(t.subjectUserId),
    check(
      'deletion_jobs_status_check',
      sql`${t.status} in (${sql.raw(sqlValueList(DELETION_STATUSES))})`,
    ),
    check(
      'deletion_jobs_completed_pair_check',
      sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`,
    ),
  ],
);

/**
 * 기능 플래그 / kill switch (공통 02 §7, 공통 01 §8).
 *
 * 잘못된 문항/광고/푸시 루프가 생겼을 때 재배포 없이 끌 수 있어야 한다.
 * 값을 DB 에 두는 이유가 그것이다.
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    key: text('key').primaryKey(),
    enabled: boolean('enabled').notNull().default(false),
    description: text('description').notNull(),
    updatedBy: uuid('updated_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('feature_flags_key_check', sql`length(${t.key}) > 0`)],
);

/**
 * 숙련도 재계산 작업 (07 §9, 09 §5).
 *
 * 문항이 void 되면 그 문항을 푼 모든 사용자의 mastery 를 다시 계산해야 한다.
 * 사용자 수가 많을 수 있으므로 void 트랜잭션에서 동기 처리하지 않고
 * 작업으로 남긴 뒤 배치가 처리한다.
 *
 * 작업은 멱등하다. 중간에 실패해도 다시 돌리면 같은 결과가 된다.
 */
export const masteryRecalcJobs = pgTable(
  'mastery_recalc_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionRevisionId: uuid('question_revision_id')
      .notNull()
      .references(() => questionRevisions.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    totalUsers: integer('total_users').notNull().default(0),
    processedUsers: integer('processed_users').notNull().default(0),
    requestedBy: uuid('requested_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mastery_recalc_jobs_status_idx').on(t.status, t.createdAt),
    check(
      'mastery_recalc_jobs_status_check',
      sql`${t.status} in (${sql.raw(sqlValueList(RECALC_STATUSES))})`,
    ),
    check(
      'mastery_recalc_jobs_reason_check',
      sql`${t.reason} in (${sql.raw(sqlValueList(RECALC_REASONS))})`,
    ),
    check(
      'mastery_recalc_jobs_progress_check',
      sql`${t.processedUsers} >= 0 and ${t.totalUsers} >= 0`,
    ),
  ],
);
