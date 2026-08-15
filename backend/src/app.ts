import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerErrorHandler } from './http/error-handler.ts';
import { registerSecurity } from './http/security.ts';
import type { AppInstance } from './http/types.ts';
import { logger } from './observability/logger.ts';
import { registerHealthRoutes } from './routes/health.ts';

/**
 * Fastify 애플리케이션 조립.
 *
 * 요청마다 내부 requestId 를 만들어 로그와 오류 envelope 에 함께 남긴다 (공통 05 §2).
 * 클라이언트가 보낸 요청 ID 는 신뢰하지 않는다(위조/추적 오염 방지). 항상 서버가 생성한다.
 */
export async function buildApp(): Promise<AppInstance> {
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
  registerErrorHandler(app);

  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-request-id', request.id);
    done(null, payload);
  });

  registerHealthRoutes(app);

  return app;
}
