import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import type { ErrorEnvelope } from './errors.ts';
import { classifyCorsOrigin, resolveAllowedOrigins, tossMiniAppOrigins } from './security.ts';
import type { AppInstance } from './types.ts';

describe('tossMiniAppOrigins', () => {
  it('Origin 진단은 알려진 앱 주소만 분류하고 임의 입력은 노출하지 않는다', () => {
    expect(classifyCorsOrigin('https://hanguksa5min.private-web.tossmini.com')).toBe(
      'private-web.tossmini.com',
    );
    expect(classifyCorsOrigin('https://hanguksa5min.web.tossmini.com')).toBe('web.tossmini.com');
    expect(classifyCorsOrigin('null')).toBe('opaque');
    expect(classifyCorsOrigin('https://private-token.attacker.example')).toBe('unrecognized');
    expect(classifyCorsOrigin('https://hanguksa5min.web.tossmini.com?token=secret')).toBe(
      'unrecognized',
    );
  });

  it('appName 에서 실서비스/QR 테스트 origin 을 파생한다 (SDK 3.x CORS 규칙)', () => {
    expect(tossMiniAppOrigins('hanguksa5min')).toEqual([
      'https://hanguksa5min.apps.tossmini.com',
      'https://hanguksa5min.private-apps.tossmini.com',
    ]);
  });

  it('테스트 환경에서는 허용 목록에 앱인토스 origin 이 포함된다', () => {
    expect(resolveAllowedOrigins()).toContain('https://hanguksa5min.apps.tossmini.com');
  });
});

describe('보안 헤더와 오류 응답', () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('거절된 사전 요청의 플랫폼 분류를 기록한다', async () => {
    const entries: unknown[] = [];

    const spy = vi.spyOn(app.log, 'child').mockImplementation(() => {
      const log = Object.create(app.log) as ReturnType<typeof app.log.child>;
      log.info = (...args: unknown[]) => {
        entries.push(args);
      };
      return log;
    });
    try {
      await app.inject({
        method: 'OPTIONS',
        url: '/v1/auth/bootstrap',
        headers: {
          origin: 'https://hanguksa5min.private-web.tossmini.com',
          'access-control-request-method': 'POST',
        },
      });
      expect(entries).toContainEqual([
        { originClass: 'private-web.tossmini.com' },
        'auth_cors_origin_rejected',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    'https://hanguksa5min.apps.tossmini.com',
    'https://hanguksa5min.private-apps.tossmini.com',
  ])('새 미니앱 주소 %s 의 인증 사전 요청을 허용한다', async (origin) => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/bootstrap',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization,idempotency-key',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-headers']).toBe(
      'Content-Type, Authorization, Idempotency-Key',
    );
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it.each([
    'https://other-app.apps.tossmini.com',
    'https://hanguksa5min.apps.tossmini.com.attacker.example',
    'http://hanguksa5min.apps.tossmini.com',
  ])('다른 앱이나 위장 주소 %s 에 사전 요청을 허용하지 않는다', async (origin) => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/bootstrap',
      headers: { origin, 'access-control-request-method': 'POST' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('health 는 200 을 돌려준다', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('모든 응답에 no-store 와 no-referrer 를 적용한다 (공통 06 §3)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('요청마다 서버가 만든 requestId 를 헤더로 돌려준다', async () => {
    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });

    expect(first.headers['x-request-id']).toBeTruthy();
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('클라이언트가 보낸 요청 ID 를 신뢰하지 않는다', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'client-supplied' },
    });

    expect(response.headers['x-request-id']).not.toBe('client-supplied');
  });

  it('content-type 만 있고 본문이 비어도 400 이 아니다', async () => {
    // 본문이 필요 없는 POST 에 재시도 라이브러리가 헤더를 붙이는 경우가 있다.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    // 인증이 없으므로 401 이 맞다. 본문 파싱 단계에서 400 이 나면 안 된다.
    expect(response.statusCode).toBe(401);
  });

  it('깨진 JSON 은 그대로 400 이다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    });

    expect(response.statusCode).toBe(400);
  });

  it('없는 경로는 공통 오류 envelope 로 404 를 돌려준다', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);

    const body = response.json<ErrorEnvelope>();
    expect(body.code).toBe('NOT_FOUND');
    expect(body.retryable).toBe(false);
    expect(typeof body.message).toBe('string');
    expect(body.requestId).toBe(response.headers['x-request-id']);
  });

  it('허용된 origin 에만 CORS 를 열어준다', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://hanguksa5min.apps.tossmini.com' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://hanguksa5min.apps.tossmini.com',
    );
  });

  it('허용되지 않은 origin 에는 CORS 헤더를 주지 않는다', async () => {
    const blocked = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://attacker.example.com' },
    });

    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('쿠키 자격증명을 허용하지 않는다 (Bearer 방식, 공통 06 §4)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://hanguksa5min.apps.tossmini.com' },
    });

    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
