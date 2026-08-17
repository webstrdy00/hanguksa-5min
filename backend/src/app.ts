import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { IdentityProvider } from './auth/identity-provider.ts';
import { createIdentityProvider } from './auth/provider-factory.ts';
import { AuthService } from './auth/service.ts';
import { registerErrorHandler } from './http/error-handler.ts';
import { registerSecurity } from './http/security.ts';
import type { AppInstance } from './http/types.ts';
import { logger } from './observability/logger.ts';
import { registerAdminExamRoutes } from './routes/admin-exams.ts';
import { registerAdminQuestionRoutes } from './routes/admin-questions.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerExamRoutes } from './routes/exams.ts';
import { registerHealthRoutes } from './routes/health.ts';

/**
 * Fastify 애플리케이션 조립.
 *
 * 요청마다 내부 requestId 를 만들어 로그와 오류 envelope 에 함께 남긴다 (공통 05 §2).
 * 클라이언트가 보낸 요청 ID 는 신뢰하지 않는다(위조/추적 오염 방지). 항상 서버가 생성한다.
 */
export interface BuildAppOptions {
  /**
   * 식별키 검증 구현체 주입 (테스트용 이음).
   * 지정하지 않으면 환경변수에 따라 toss / mock 을 골라 생성한다.
   */
  identityProvider?: IdentityProvider;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<AppInstance> {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 1024 * 256,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: false,
      },
    },
  });

  await registerSecurity(app);

  // 레이트리밋은 라우트별로 명시해서 건다 (공통 04 §3).
  await app.register(rateLimit, { global: false });

  registerErrorHandler(app);

  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-request-id', request.id);
    done(null, payload);
  });

  registerHealthRoutes(app);
  const identityProvider = options.identityProvider ?? createIdentityProvider();
  registerAuthRoutes(app, new AuthService(identityProvider));
  registerExamRoutes(app);
  registerAdminExamRoutes(app);
  registerAdminQuestionRoutes(app);

  return app;
}
