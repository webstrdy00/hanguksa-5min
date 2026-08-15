import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ADMIN_ROLES, ADMIN_STATUSES, AUDIT_ACTIONS, sqlValueList } from './enums.ts';

/**
 * 운영자 계정.
 *
 * question_revisions.reviewer_id 와 감사 로그가 참조할 대상이다.
 * 관리자 인증 방식은 아직 미정이므로(AGENTS.md §9 #12) 자격증명 컬럼을 두지 않는다.
 * 비밀번호/토큰을 이 테이블에 추가하지 말고, 인증 방식이 정해지면 별도로 설계한다.
 */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('admin_users_email_key').on(t.email),
    check('admin_users_role_check', sql`${t.role} in (${sql.raw(sqlValueList(ADMIN_ROLES))})`),
    check(
      'admin_users_status_check',
      sql`${t.status} in (${sql.raw(sqlValueList(ADMIN_STATUSES))})`,
    ),
  ],
);

/**
 * 관리자 감사 로그 (공통 04 §2).
 *
 * 콘텐츠 publish/retire/void/delete 와 일정 변경, 삭제 처리를 남긴다.
 * 개인정보와 분리된 운영 기록이며 내부 권장 보관 기간은 180일이다(하드게이트 §2).
 */
export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 계정이 지워져도 감사 기록 자체는 남는다. */
    actorAdminId: uuid('actor_admin_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    /** 사용자 답변 원문/anonKey/token 을 넣지 않는다 (공통 04 §4). */
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_audit_logs_created_at_idx').on(t.createdAt),
    index('admin_audit_logs_target_idx').on(t.targetType, t.targetId),
    check(
      'admin_audit_logs_action_check',
      sql`${t.action} in (${sql.raw(sqlValueList(AUDIT_ACTIONS))})`,
    ),
  ],
);
