import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { featureFlags } from '../db/schema/ops.ts';
import { AppError } from '../http/errors.ts';
import { writeAuditLog } from './audit.ts';

/**
 * 기능 플래그 / kill switch (공통 02 §7, 공통 01 §8).
 *
 * 잘못된 문항이나 알림 루프가 터졌을 때 **앱 재배포 없이** 기능을 끌 수 있어야 한다.
 * 그래서 값을 DB 에 둔다.
 *
 * 조회는 캐시하지 않는다. kill switch 는 즉시 반영돼야 의미가 있다.
 * 트래픽이 늘어 부담이 되면 짧은 TTL 캐시를 붙이되 "즉시성"을 먼저 검증한다.
 */

export const FLAG_DAILY_STUDY = 'daily_study';
export const FLAG_PUSH_NOTIFICATION = 'push_notification';
export const FLAG_QUESTION_REPORT = 'question_report';

export interface FlagView {
  key: string;
  enabled: boolean;
  description: string;
}

export async function listFlags(): Promise<FlagView[]> {
  const rows = await db
    .select({
      key: featureFlags.key,
      enabled: featureFlags.enabled,
      description: featureFlags.description,
    })
    .from(featureFlags)
    .orderBy(featureFlags.key);

  return rows;
}

/**
 * 플래그가 켜져 있는지 확인한다.
 * 등록되지 않은 키는 **켜진 것으로 본다**. 플래그를 안 만들었다고 기능이 죽으면 안 된다.
 */
export async function isEnabled(key: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(eq(featureFlags.key, key))
    .limit(1);

  return row?.enabled ?? true;
}

/** 꺼져 있으면 503 으로 막는다. 사용자에게는 일시 중단으로 안내한다. */
export async function assertEnabled(key: string, userMessage: string): Promise<void> {
  if (await isEnabled(key)) return;

  throw new AppError('DEPENDENCY_UNAVAILABLE', {
    userMessage,
    details: { feature: key },
  });
}

export async function setFlag(params: {
  key: string;
  enabled: boolean;
  adminId: string;
}): Promise<FlagView> {
  const [current] = await db
    .select({ key: featureFlags.key })
    .from(featureFlags)
    .where(eq(featureFlags.key, params.key))
    .limit(1);

  if (current == null) throw new AppError('NOT_FOUND');

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(featureFlags)
      .set({ enabled: params.enabled, updatedBy: params.adminId, updatedAt: new Date() })
      .where(eq(featureFlags.key, params.key))
      .returning({
        key: featureFlags.key,
        enabled: featureFlags.enabled,
        description: featureFlags.description,
      });

    await writeAuditLog(tx, {
      actorAdminId: params.adminId,
      action: 'toggle_feature_flag',
      targetType: 'feature_flag',
      detail: { key: params.key, enabled: params.enabled },
    });

    return row;
  });

  if (updated == null) throw new AppError('INTERNAL_ERROR');
  return updated;
}
