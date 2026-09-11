import { env } from '../config/env.ts';
import { pingDb } from '../db/client.ts';
import { AppError } from '../http/errors.ts';
import type { AppInstance } from '../http/types.ts';

/**
 * 배포 후 health check / smoke test 용 엔드포인트 (공통 06 §5 Post-deploy).
 *
 * - /health      : 프로세스 생존 확인. 외부 의존성을 건드리지 않는다.
 * - /health/ready: DB 연결까지 확인. 실패 시 503 DEPENDENCY_UNAVAILABLE.
 *
 * 사용자 데이터를 다루지 않으므로 개인정보가 응답에 포함되지 않는다.
 */
export function registerHealthRoutes(app: AppInstance): void {
  app.get('/health', () => {
    return {
      status: 'ok',
      appEnv: env.APP_ENV,
      time: new Date().toISOString(),
    };
  });

  app.get('/health/ready', async () => {
    try {
      await pingDb();
    } catch (error) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', { cause: error });
    }
    return { status: 'ready' };
  });
}
