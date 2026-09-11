import { env } from '../config/env.ts';
import { logger } from '../observability/logger.ts';
import type { IdentityProvider, VerificationOutcome } from './identity-provider.ts';

/**
 * ⚠️ MOCK 구현체 ⚠️
 *
 * 앱인토스 mTLS 인증서를 아직 발급받지 못해 실제 검증 API 를 호출할 수 없는 동안만 쓴다.
 * 인증서가 준비되면 IDENTITY_PROVIDER=toss 로 바꾸고 이 파일은 개발/테스트 전용으로만 남긴다.
 *
 * 안전장치:
 * - 운영 환경에서는 생성 자체가 실패한다 (env 검증에서도 한 번, 여기서 한 번 더).
 * - 사용될 때마다 경고 로그를 남긴다. 조용히 통과하지 않는다.
 *
 * 개발용 판정 규칙 (실제 API 동작과 무관한 임의 규칙):
 *   'mock-invalid' 로 시작 -> 무효한 키
 *   'mock-unavailable' 로 시작 -> 검증 API 장애
 *   그 외 -> 유효
 */
export class MockIdentityProvider implements IdentityProvider {
  readonly name = 'mock';

  constructor() {
    if (env.APP_ENV === 'production') {
      throw new Error('MOCK 식별키 검증은 운영 환경에서 사용할 수 없습니다.');
    }
    logger.warn(
      { provider: this.name, appEnv: env.APP_ENV },
      'MOCK_identity_provider_enabled: 실제 앱인토스 검증을 수행하지 않습니다',
    );
  }

  verifyAnonKey(anonKey: string): Promise<VerificationOutcome> {
    if (anonKey.startsWith('mock-invalid')) {
      return Promise.resolve({ status: 'invalid', reason: 'mock_invalid_key' });
    }
    if (anonKey.startsWith('mock-unavailable')) {
      return Promise.resolve({ status: 'unavailable', reason: 'mock_provider_unavailable' });
    }
    return Promise.resolve({ status: 'valid' });
  }
}
