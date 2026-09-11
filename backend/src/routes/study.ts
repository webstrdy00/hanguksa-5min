import { z } from 'zod';
import { authenticate, requireUser } from '../http/authenticate.ts';
import { AppError } from '../http/errors.ts';
import type { AppInstance } from '../http/types.ts';
import { FLAG_DAILY_STUDY, assertEnabled } from '../services/feature-flags.ts';
import { completeSession, startTodaySession, submitAnswer } from '../services/study-session.ts';

/**
 * 오늘 학습 세션 API (08 §2).
 *
 * 멱등성은 헤더가 아니라 DB 자연 키로 보장한다.
 *   · 세션: UNIQUE(user_id, study_date)
 *   · 답안: UNIQUE(session_id, question_revision_id)
 * Idempotency-Key 보다 강한 보장이다. 키가 달라도 중복이 생기지 않는다.
 */

const answerSchema = z.object({
  questionRevisionId: z.string().uuid(),
  selectedIndex: z.number().int().min(0).max(4),
});

const sessionParamsSchema = z.object({ id: z.string().uuid() });

function invalidRequest(error: z.ZodError): AppError {
  return new AppError('INVALID_REQUEST', {
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
}

export function registerStudyRoutes(app: AppInstance): void {
  /** 08 §2: 답안 제출 30 req/min (공통 04 §3) */
  const answerRateLimit = app.rateLimit({
    max: 30,
    timeWindow: '1 minute',
    keyGenerator: (request) => `answer:${request.authenticatedUser?.id ?? request.ip}`,
  });

  app.post('/v1/study/today', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request);

    // 잘못된 문항이 대량으로 나간 경우 재배포 없이 즉시 막을 수 있어야 한다 (공통 02 §7).
    await assertEnabled(
      FLAG_DAILY_STUDY,
      '오늘의 학습을 잠시 준비 중이에요. 잠시 후 다시 시도해주세요.',
    );

    const view = await startTodaySession(user.id, new Date());

    request.log.info(
      { sessionId: view.session.id, completed: view.session.completedAt != null },
      'study_session_started',
    );

    return view;
  });

  app.post(
    '/v1/sessions/:id/answer',
    { preHandler: [authenticate, answerRateLimit] },
    async (request) => {
      const user = requireUser(request);

      const params = sessionParamsSchema.safeParse(request.params);
      if (!params.success) throw invalidRequest(params.error);

      const parsed = answerSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      const result = await submitAnswer(
        user.id,
        params.data.id,
        parsed.data.questionRevisionId,
        parsed.data.selectedIndex,
        new Date(),
      );

      // 선택한 답 자체는 로그에 남기지 않는다 (07 §7).
      request.log.info(
        { sessionId: params.data.id, replayed: result.replayed },
        'study_answer_submitted',
      );

      return result;
    },
  );

  app.post('/v1/sessions/:id/complete', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request);

    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) throw invalidRequest(params.error);

    const result = await completeSession(user.id, params.data.id, new Date());

    request.log.info(
      { sessionId: params.data.id, alreadyCompleted: result.alreadyCompleted },
      'study_session_completed',
    );

    return result;
  });
}
