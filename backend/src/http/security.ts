import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { env, isProduction } from '../config/env.ts';
import type { AppInstance } from './types.ts';

/**
 * WebView 웹보안 P0 (공통 06 §3).
 *
 * - 상태 변경은 allowlist origin 에서만 허용한다. credential 과 wildcard CORS 를 결합하지 않는다.
 * - Referrer-Policy: no-referrer 로 토큰이 외부 referrer 로 전파되지 않게 한다.
 * - 민감 응답은 no-store 로 CDN/브라우저 캐시에 남지 않게 한다.
 *   이 API 는 전부 사용자별 동적 응답이므로 기본값을 no-store 로 둔다.
 *
 * CORS origin 은 콘솔의 2026-08-25 주소 변경 안내 기준으로 appName 에서 파생된다.
 *   https://<appName>.apps.tossmini.com          실서비스
 *   https://<appName>.private-apps.tossmini.com  콘솔 QR 테스트
 * SDK 3.x web/private-web 주소도 현재 사용된다(2026-09-21 실제 QR 요청 확인).
 * 다른 앱이나 임의 하위 도메인이 아니라 이 앱의 정확한 네 주소만 허용한다.
 */
export function tossMiniAppOrigins(appName: string): readonly string[] {
  return [
    `https://${appName}.apps.tossmini.com`,
    `https://${appName}.private-apps.tossmini.com`,
    `https://${appName}.web.tossmini.com`,
    `https://${appName}.private-web.tossmini.com`,
  ];
}

export function resolveAllowedOrigins(): readonly string[] {
  const origins = [...tossMiniAppOrigins(env.APP_NAME)];

  // 운영에서는 추가 origin 을 허용하지 않는다.
  if (!isProduction && env.ADDITIONAL_CORS_ORIGINS != null) {
    for (const origin of env.ADDITIONAL_CORS_ORIGINS.split(',')) {
      const trimmed = origin.trim();
      if (trimmed.length > 0) origins.push(trimmed);
    }
  }

  return origins;
}

/** 임의 Origin 원문 대신 이 앱의 알려진 플랫폼 주소만 진단한다. */
export function classifyCorsOrigin(origin: string): string {
  if (origin === 'null') return 'opaque';
  for (const domain of [
    'apps.tossmini.com',
    'private-apps.tossmini.com',
    'web.tossmini.com',
    'private-web.tossmini.com',
  ]) {
    if (origin === `https://${env.APP_NAME}.${domain}`) return domain;
  }
  return 'unrecognized';
}

export async function registerSecurity(app: AppInstance): Promise<void> {
  const allowedOrigins = resolveAllowedOrigins();

  app.addHook('onRequest', (request, _reply, done) => {
    const origin = request.headers.origin;
    if (
      request.method === 'OPTIONS' &&
      request.url === '/v1/auth/bootstrap' &&
      (origin == null || !allowedOrigins.includes(origin))
    ) {
      request.log.info(
        { originClass: origin == null ? 'missing' : classifyCorsOrigin(origin) },
        'auth_cors_origin_rejected',
      );
    }
    done();
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // 같은 WebView 안에서의 요청처럼 Origin 헤더가 없는 경우는 CORS 검사 대상이 아니다.
      if (origin == null) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.includes(origin));
    },
    // 인증은 Authorization: Bearer(메모리 보관) 를 쓴다. 쿠키를 쓰지 않으므로 credentials 를 켜지 않는다.
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    maxAge: 600,
  });

  await app.register(helmet, {
    // JSON API 이므로 스크립트/스타일 소스를 전부 차단한다.
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    done(null, payload);
  });
}
