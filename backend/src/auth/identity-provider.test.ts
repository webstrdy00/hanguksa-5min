import { describe, expect, it } from 'vitest';
import { interpretVerifyResponse } from './identity-provider.ts';

/**
 * 앱인토스 검증 API 응답 해석.
 *
 * 이 API 는 비즈니스 오류를 HTTP 200 으로 내려준다.
 * HTTP 상태코드만 보고 판단하면 무효한 식별키가 인증을 통과한다.
 */
describe('interpretVerifyResponse', () => {
  it('SUCCESS + success:true 는 유효한 키다', () => {
    expect(interpretVerifyResponse(200, { resultType: 'SUCCESS', success: true })).toEqual({
      status: 'valid',
    });
  });

  it('SUCCESS + success:false 는 무효한 키다 (HTTP 200 이어도 통과시키지 않는다)', () => {
    expect(interpretVerifyResponse(200, { resultType: 'SUCCESS', success: false })).toEqual({
      status: 'invalid',
      reason: 'not_verified',
    });
  });

  it('errorCode 4010 은 무효한 키다', () => {
    const outcome = interpretVerifyResponse(200, {
      resultType: 'FAIL',
      error: { errorCode: '4010', reason: '인증 정보를 찾을 수 없어요.' },
    });

    expect(outcome).toEqual({ status: 'invalid', reason: 'unauthenticated' });
  });

  it('errorCode 4095 는 일시 장애로 처리하고 retryAfterSeconds 를 읽는다', () => {
    const outcome = interpretVerifyResponse(200, {
      resultType: 'FAIL',
      error: { errorCode: '4095', reason: '요청 한도 초과', data: { retryAfterSeconds: 12 } },
    });

    expect(outcome).toEqual({
      status: 'unavailable',
      reason: 'provider_rate_limited',
      retryAfterSeconds: 12,
    });
  });

  it('retryAfterSeconds 가 없어도 4095 를 처리한다', () => {
    const outcome = interpretVerifyResponse(200, {
      resultType: 'FAIL',
      error: { errorCode: '4095', reason: '요청 한도 초과' },
    });

    expect(outcome).toEqual({ status: 'unavailable', reason: 'provider_rate_limited' });
  });

  it('알 수 없는 비즈니스 오류는 무효가 아니라 장애로 본다', () => {
    const outcome = interpretVerifyResponse(200, {
      resultType: 'FAIL',
      error: { errorCode: '9999', reason: '알 수 없음' },
    });

    expect(outcome).toEqual({ status: 'unavailable', reason: 'business_error_9999' });
  });

  it.each(['HTTP_TIMEOUT', 'NETWORK_ERROR', 'EXECUTION_FAIL', 'INTERRUPTED', 'INTERNAL_ERROR'])(
    'resultType %s 는 일시 장애다',
    (resultType) => {
      const outcome = interpretVerifyResponse(200, { resultType, error: { errorCode: 'x' } });
      expect(outcome.status).toBe('unavailable');
    },
  );

  it('HTTP 400 은 우리 요청 버그이므로 사용자를 막지 않고 장애로 처리한다', () => {
    expect(interpretVerifyResponse(400, { resultType: 'FAIL' })).toEqual({
      status: 'unavailable',
      reason: 'bad_request',
    });
  });

  it('HTTP 500 은 일시 장애다', () => {
    expect(interpretVerifyResponse(500, null)).toEqual({
      status: 'unavailable',
      reason: 'http_500',
    });
  });

  it('예상치 못한 응답 형태는 유효로 처리하지 않는다', () => {
    expect(interpretVerifyResponse(200, null).status).toBe('unavailable');
    expect(interpretVerifyResponse(200, 'ok').status).toBe('unavailable');
    expect(interpretVerifyResponse(200, {}).status).toBe('unavailable');
    expect(interpretVerifyResponse(200, { resultType: 'SUCCESS' }).status).toBe('unavailable');
    expect(interpretVerifyResponse(200, { resultType: 'SUCCESS', success: 'true' }).status).toBe(
      'unavailable',
    );
    expect(interpretVerifyResponse(200, { resultType: 'WEIRD' }).status).toBe('unavailable');
  });
});
