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
import { registerAccountRoutes } from './routes/account.ts';
import { registerNotificationRoutes } from './routes/notifications.ts';
import { registerOpsRoutes } from './routes/ops.ts';
import { registerProgressRoutes } from './routes/progress.ts';
import { registerStudyRoutes } from './routes/study.ts';
import { registerWrongNoteRoutes } from './routes/wrong-notes.ts';

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

  /**
   * 본문이 없는 POST 를 허용한다.
   *
   * `POST /v1/study/today` 같은 엔드포인트는 본문이 필요 없다.
   * 그런데 클라이언트가 content-type: application/json 을 붙이고 빈 본문을 보내면
   * 기본 파서가 400 을 낸다. 재시도 라이브러리나 프록시가 헤더를 붙이는 경우가 있어
   * 빈 본문은 본문 없음으로 취급한다. 깨진 JSON 은 그대로 400 이다.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, payload, done) => {
    const raw = typeof payload === 'string' ? payload.trim() : '';
    if (raw.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      // Fastify 기본 파서처럼 400 으로 내려준다. statusCode 가 없으면 500 으로 잡힌다.
      const parseError = Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
      done(parseError, undefined);
    }
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
  registerStudyRoutes(app);
  registerProgressRoutes(app);
  registerOpsRoutes(app);
  registerAccountRoutes(app);
  registerNotificationRoutes(app);
  registerWrongNoteRoutes(app);

  return app;
}
