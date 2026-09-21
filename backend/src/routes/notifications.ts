import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { users } from '../db/schema/identity.ts';
import { notificationConsents } from '../db/schema/ops.ts';
import { withLiveJournalSubject } from '../deletion-journal/runtime.ts';
import { authenticate, requireUser } from '../http/authenticate.ts';
import { AppError } from '../http/errors.ts';
import type { AppInstance } from '../http/types.ts';

/**
 * 알림 동의 상태 (공통 01 §4, 공통 04 §1, 07 §7).
 *
 * 규칙:
 * - 기능성 알림("오늘 5문제 미완료", "D-day")과 광고성 스마트 발송을 **분리**해서 관리한다.
 * - 사용자가 알림을 켜는 명확한 행동이 있을 때만 동의를 기록한다.
 * - 동의 없이는 발송 대상에 들어가지 않는다 (9단계 발송 worker 의 전제).
 * - 동의 시각을 함께 남긴다. DB CHECK 가 동의=true 인데 시각이 없는 상태를 막는다.
 *
 * 실제 동의 화면은 클라이언트가 SDK 의 Notification.requestAgreement 로 띄운다.
 * 이 API 는 그 **결과를 서버에 기록**하는 역할이다.
 */

const consentSchema = z.object({
  /** SDK 가 돌려준 결과. 거절도 기록해야 재요청 여부를 판단할 수 있다. */
  result: z.enum(['newAgreement', 'alreadyAgreed', 'agreementRejected']),
  /** 기능성/광고성 구분. V1 은 기능성만 사용한다 (05 §3: V1 광고 없음). */
  channel: z.enum(['functional', 'marketing']).default('functional'),
});

export interface ConsentView {
  functionalAgreed: boolean;
  functionalAgreedAt: string | null;
  marketingAgreed: boolean;
  marketingAgreedAt: string | null;
  pushTargetStatus: string;
}

function toView(row: {
  functionalAgreed: boolean;
  functionalAgreedAt: Date | null;
  marketingAgreed: boolean;
  marketingAgreedAt: Date | null;
  pushTargetStatus: string;
}): ConsentView {
  return {
    functionalAgreed: row.functionalAgreed,
    functionalAgreedAt: row.functionalAgreedAt?.toISOString() ?? null,
    marketingAgreed: row.marketingAgreed,
    marketingAgreedAt: row.marketingAgreedAt?.toISOString() ?? null,
    pushTargetStatus: row.pushTargetStatus,
  };
}

const EMPTY_CONSENT: ConsentView = {
  functionalAgreed: false,
  functionalAgreedAt: null,
  marketingAgreed: false,
  marketingAgreedAt: null,
  pushTargetStatus: 'unknown',
};

export function registerNotificationRoutes(app: AppInstance): void {
  app.get('/v1/notifications/consent', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request);

    const [row] = await db
      .select({
        functionalAgreed: notificationConsents.functionalAgreed,
        functionalAgreedAt: notificationConsents.functionalAgreedAt,
        marketingAgreed: notificationConsents.marketingAgreed,
        marketingAgreedAt: notificationConsents.marketingAgreedAt,
        pushTargetStatus: notificationConsents.pushTargetStatus,
      })
      .from(notificationConsents)
      .where(eq(notificationConsents.userId, user.id))
      .limit(1);

    // 아직 동의 행이 없으면 "동의하지 않음" 상태다. 행을 미리 만들지 않는다.
    return { consent: row == null ? EMPTY_CONSENT : toView(row) };
  });

  app.put('/v1/notifications/consent', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request);

    const parsed = consentSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('INVALID_REQUEST', {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }

    const agreed = parsed.data.result !== 'agreementRejected';
    const now = new Date();
    const isFunctional = parsed.data.channel === 'functional';

    // 동의 시각은 동의했을 때만 남긴다. 거절이면 null 로 되돌린다.
    const agreedAt = agreed ? now : null;
    const pushTargetStatus = agreed ? 'active' : 'revoked';

    const values = isFunctional
      ? { functionalAgreed: agreed, functionalAgreedAt: agreedAt }
      : { marketingAgreed: agreed, marketingAgreedAt: agreedAt };

    // 외부 삭제 잠금을 먼저 잡고 주 DB 커밋까지 유지한다.
    const [row] = await withLiveJournalSubject(user.id, async () =>
      db.transaction(async (tx) => {
        const [currentUser] = await tx
          .select({ identityStatus: users.identityStatus })
          .from(users)
          .where(eq(users.id, user.id))
          .for('update');

        if (currentUser == null || currentUser.identityStatus === 'deleted') {
          throw new AppError('USER_DELETED');
        }
        if (currentUser.identityStatus !== 'active') {
          throw new AppError('FORBIDDEN');
        }

        return await tx
          .insert(notificationConsents)
          .values({ userId: user.id, pushTargetStatus, ...values })
          .onConflictDoUpdate({
            target: notificationConsents.userId,
            set: { pushTargetStatus, updatedAt: now, ...values },
          })
          .returning({
            functionalAgreed: notificationConsents.functionalAgreed,
            functionalAgreedAt: notificationConsents.functionalAgreedAt,
            marketingAgreed: notificationConsents.marketingAgreed,
            marketingAgreedAt: notificationConsents.marketingAgreedAt,
            pushTargetStatus: notificationConsents.pushTargetStatus,
          });
      }),
    );

    if (row == null) throw new AppError('INTERNAL_ERROR');

    // 동의 결과는 운영 지표다. 사용자 식별자는 남기지 않는다.
    request.log.info({ channel: parsed.data.channel, agreed }, 'notification_consent_updated');

    return { consent: toView(row) };
  });
}
