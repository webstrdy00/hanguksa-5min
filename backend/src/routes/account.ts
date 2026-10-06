import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { deletionJobs } from '../db/schema/ops.ts';
import { authenticate, requireUser } from '../http/authenticate.ts';
import { AppError } from '../http/errors.ts';
import type { AppInstance } from '../http/types.ts';
import { getDeletionStatus, requestDeletion } from '../services/deletion.ts';

/**
 * 계정 삭제 / 탈퇴 (공통 04 §5, 09 §6, 하드게이트 P0).
 *
 * DELETE /v1/account            삭제 요청 접수
 * GET    /v1/account/deletion/:jobId   이행 상황 조회
 *
 * 삭제는 되돌릴 수 없다. 그래서 확인 문구를 본문으로 한 번 더 받는다.
 * 공통 04 §3: 민감 작업은 짧은 연속 호출을 차단한다.
 */

const CONFIRM_PHRASE = '삭제';

const deleteSchema = z.object({
  /** 사용자가 실제로 의도했는지 확인한다. UI 의 확인 다이얼로그와 짝을 이룬다. */
  confirm: z.literal(CONFIRM_PHRASE),
});

export function registerAccountRoutes(app: AppInstance): void {
  const deleteRateLimit = app.rateLimit({
    max: 3,
    timeWindow: '10 minutes',
    keyGenerator: (request) => `account-delete:${request.authenticatedUser?.id ?? request.ip}`,
  });

  app.delete(
    '/v1/account',
    { preHandler: [authenticate, deleteRateLimit] },
    async (request, reply) => {
      const user = requireUser(request);

      const parsed = deleteSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError('INVALID_REQUEST', {
          userMessage: `삭제하려면 "${CONFIRM_PHRASE}" 를 입력해주세요.`,
          details: { confirmRequired: true },
        });
      }

      const result = await requestDeletion(user.id);

      // 어떤 사용자가 지웠는지 로그에 남기지 않는다. job 으로만 추적한다.
      request.log.info({ jobId: result.jobId }, 'account_deletion_requested');

      // 삭제 요청 이후에는 이 토큰으로 아무것도 할 수 없다.
      // identity_status = deleted 라서 다음 요청부터 403 이다.
      return await reply.status(202).send({
        jobId: result.jobId,
        status: 'requested',
        message: '삭제 요청을 접수했어요. 관련 데이터는 순차적으로 지워져요.',
      });
    },
  );

  app.get('/v1/account/deletion/:jobId', { preHandler: authenticate }, async (request) => {
    // 삭제된 계정의 토큰은 거부한다. 재가입한 계정도 이전 계정의 작업을 조회할 수 없다.
    const user = requireUser(request);

    const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new AppError('INVALID_REQUEST');

    const [ownedJob] = await db
      .select({ id: deletionJobs.id })
      .from(deletionJobs)
      .where(and(eq(deletionJobs.id, params.data.jobId), eq(deletionJobs.subjectUserId, user.id)))
      .limit(1);
    if (ownedJob == null) throw new AppError('NOT_FOUND');

    return await getDeletionStatus(params.data.jobId);
  });
}
