/**
 * 앱인토스 사용자 식별 키 검증 (공통 05 §1, 공통 06 §1).
 *
 * 공식 명세 (2026-08-15 확인):
 *   POST https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/users/anon-key/verify
 *   헤더 x-anon-key, 본문 없음, mTLS 필수, 앱당 분당 3,000회
 *
 * 중요: 비즈니스 오류가 HTTP 200 으로 내려온다.
 *       HTTP 상태코드가 아니라 resultType 을 먼저 봐야 하고,
 *       resultType 이 SUCCESS 여도 success 가 false 면 무효한 키다.
 *       이 분기를 틀리면 무효한 식별키가 그대로 인증을 통과한다.
 */

export type VerificationOutcome =
  | { status: 'valid' }
  | { status: 'invalid'; reason: string }
  | { status: 'unavailable'; reason: string; retryAfterSeconds?: number };

export interface IdentityProvider {
  /** 구현체 이름. 로그와 기동 점검에 쓴다. */
  readonly name: string;
  verifyAnonKey(anonKey: string): Promise<VerificationOutcome>;
}

/** 앱인토스가 일시 장애를 알리는 resultType 값들. */
const TRANSIENT_RESULT_TYPES = new Set([
  'HTTP_TIMEOUT',
  'NETWORK_ERROR',
  'EXECUTION_FAIL',
  'INTERRUPTED',
  'INTERNAL_ERROR',
]);

/** 인증 정보를 찾을 수 없음 (x-anon-key 헤더 누락 포함). */
const ERROR_CODE_UNAUTHENTICATED = '4010';
/** 요청 한도 초과. error.data.retryAfterSeconds 가 함께 온다. */
const ERROR_CODE_RATE_LIMITED = '4095';

interface TossEnvelope {
  resultType?: unknown;
  success?: unknown;
  error?: { errorCode?: unknown; reason?: unknown; data?: { retryAfterSeconds?: unknown } };
}

/**
 * 검증 API 응답을 우리 결과 타입으로 변환한다.
 * 네트워크 없이 단위 테스트할 수 있도록 순수 함수로 둔다.
 */
export function interpretVerifyResponse(httpStatus: number, body: unknown): VerificationOutcome {
  if (httpStatus === 400) {
    // 우리가 잘못된 요청을 보냈다는 뜻이다. 사용자를 막지 말고 장애로 처리한 뒤 경고를 남긴다.
    return { status: 'unavailable', reason: 'bad_request' };
  }

  if (httpStatus !== 200) {
    return { status: 'unavailable', reason: `http_${httpStatus}` };
  }

  if (typeof body !== 'object' || body == null) {
    return { status: 'unavailable', reason: 'unexpected_response' };
  }

  const envelope = body as TossEnvelope;
  const resultType = envelope.resultType;

  if (resultType === 'SUCCESS') {
    // success 는 boolean 이다. false 면 "검증했더니 무효한 키"라는 뜻이다.
    if (envelope.success === true) return { status: 'valid' };
    if (envelope.success === false) return { status: 'invalid', reason: 'not_verified' };
    return { status: 'unavailable', reason: 'unexpected_success_payload' };
  }

  if (resultType === 'FAIL') {
    const errorCode =
      typeof envelope.error?.errorCode === 'string' ? envelope.error.errorCode : 'unknown';

    if (errorCode === ERROR_CODE_UNAUTHENTICATED) {
      return { status: 'invalid', reason: 'unauthenticated' };
    }

    if (errorCode === ERROR_CODE_RATE_LIMITED) {
      const retryAfter = envelope.error?.data?.retryAfterSeconds;
      const outcome: VerificationOutcome = {
        status: 'unavailable',
        reason: 'provider_rate_limited',
      };
      if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
        return { ...outcome, retryAfterSeconds: retryAfter };
      }
      return outcome;
    }

    return { status: 'unavailable', reason: `business_error_${errorCode}` };
  }

  if (typeof resultType === 'string' && TRANSIENT_RESULT_TYPES.has(resultType)) {
    return { status: 'unavailable', reason: resultType.toLowerCase() };
  }

  return { status: 'unavailable', reason: 'unexpected_response' };
}
