import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { computeFingerprint } from '../auth/fingerprint.ts';
import type { AuthService } from '../auth/service.ts';
import { env } from '../config/env.ts';
import { db } from '../db/client.ts';
import { users } from '../db/schema/identity.ts';
import { authenticate, requireUser } from '../http/authenticate.ts';
import { AppError } from '../http/errors.ts';
import type { AppInstance } from '../http/types.ts';

/**
 * 인증 라우트 (공통 05 §1, 공통 06 §1).
 *
 * anonKey 는 이 엔드포인트에서만 받는다. 이후 API 는 내부 access token 만 쓴다.
 * anonKey 는 본문으로만 받는다. 쿼리스트링에 넣으면 접근 로그·referrer 에 남는다.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** 레이트리밋 버킷 키. anonKey 원문이 아니라 HMAC 값이다. */
    bootstrapRateKey?: string;
  }
}

const bootstrapSchema = z.object({
  // 앱인토스 SDK 가 주는 식별키. 형식은 플랫폼 소유이므로 길이만 방어적으로 제한한다.
  anonKey: z.string().min(8).max(512),
  appVersion: z.string().max(32).optional(),
});

export function registerAuthRoutes(app: AppInstance, authService: AuthService): void {
  /** IP 기준 제한 (내부 시작값). fingerprint 기준 제한은 핸들러 안에서 추가로 건다. */
  const ipRateLimit = app.rateLimit({
    max: 60,
    timeWindow: '10 minutes',
    keyGenerator: (request) => `bootstrap:ip:${request.ip}`,
  });

  const anonKeyRateLimit = app.createRateLimit({
    max: 30,
    timeWindow: '10 minutes',
    keyGenerator: (request) => `bootstrap:key:${request.bootstrapRateKey ?? request.ip}`,
  });

  app.post('/v1/auth/bootstrap', { preHandler: ipRateLimit }, async (request, reply) => {
    const parsed = bootstrapSchema.safeParse(request.body);
    if (!parsed.success) {
      // 어떤 필드가 틀렸는지만 알린다. 값은 절대 싣지 않는다.
      throw new AppError('INVALID_REQUEST', {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }

    // 같은 식별키가 반복 호출되는 경우를 IP 와 별개로 제한한다.
    // 버킷 키는 원문이 아니라 HMAC 값이다. 메모리 스토어에도 원문을 두지 않는다.
    request.bootstrapRateKey = computeFingerprint(parsed.data.anonKey, env.SERVER_PEPPER);
    const limit = await anonKeyRateLimit(request);
    // 주의: isAllowed 는 "허용된 요청"이 아니라 "allowList 에 등재된 키"를 뜻한다.
    // 실제 한도 초과 판정은 isExceeded / isBanned 로 한다.
    if (limit.isAllowed === false && (limit.isExceeded || limit.isBanned)) {
      throw new AppError('RATE_LIMITED');
    }

    const result = await authService.bootstrap(parsed.data.anonKey);

    if (parsed.data.appVersion != null) {
      await db
        .update(users)
        .set({ appVersion: parsed.data.appVersion, lastSeenAt: new Date() })
        .where(eq(users.id, result.userId));
    }

    request.log.info(
      { created: result.created, verified: result.verified },
      'auth_bootstrap_completed',
    );

    return await reply.status(result.created ? 201 : 200).send({
      accessToken: result.accessToken.token,
      expiresIn: result.accessToken.expiresInSeconds,
      tokenType: 'Bearer',
    });
  });

  /** 인증 미들웨어가 실제로 동작하는지 확인하는 최소 엔드포인트. */
  app.get('/v1/me', { preHandler: authenticate }, (request) => {
    const user = requireUser(request);
    return { userId: user.id };
  });
}
