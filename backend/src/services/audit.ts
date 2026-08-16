import type { db } from '../db/client.ts';
import { adminAuditLogs } from '../db/schema/admin.ts';
import type { AuditAction } from '../db/schema/enums.ts';

/**
 * 관리자 감사 로그 (공통 04 §2).
 *
 * 콘텐츠 publish/retire/void/delete 와 일정 변경은 예외 없이 기록한다.
 * detail 에는 사용자 답변 원문/anonKey/token 을 넣지 않는다 (공통 04 §4).
 */

/** db 자체 또는 트랜잭션 핸들. 감사 로그는 대상 변경과 같은 트랜잭션에 들어가야 한다. */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;

export interface AuditEntry {
  actorAdminId: string;
  action: AuditAction;
  targetType: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

export async function writeAuditLog(executor: Executor, entry: AuditEntry): Promise<void> {
  await executor.insert(adminAuditLogs).values({
    actorAdminId: entry.actorAdminId,
    action: entry.action,
    targetType: entry.targetType,
    ...(entry.targetId == null ? {} : { targetId: entry.targetId }),
    ...(entry.detail == null ? {} : { detail: entry.detail }),
  });
}
