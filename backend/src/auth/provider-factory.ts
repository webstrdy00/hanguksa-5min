import { env } from '../config/env.ts';
import type { IdentityProvider } from './identity-provider.ts';
import { MockIdentityProvider } from './mock-identity-provider.ts';
import { TossIdentityProvider } from './toss-identity-provider.ts';

/**
 * 식별키 검증 구현체 선택.
 *
 * env 검증에서 이미 `APP_ENV=production + IDENTITY_PROVIDER=mock` 조합을 막지만,
 * 여기서 한 번 더 확인한다. 인증 우회는 되돌릴 수 없는 사고라 이중으로 막는다.
 */
export function createIdentityProvider(): IdentityProvider {
  if (env.IDENTITY_PROVIDER === 'toss') {
    return new TossIdentityProvider();
  }

  if (env.APP_ENV === 'production') {
    throw new Error('운영 환경에서는 MOCK 식별키 검증을 사용할 수 없습니다.');
  }

  return new MockIdentityProvider();
}
