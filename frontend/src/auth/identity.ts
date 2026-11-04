import { Environment, User } from '@apps-in-toss/web-framework';

/**
 * 앱인토스 사용자 식별키 획득 (공통 06 §1 1단계).
 *
 * 설치된 @apps-in-toss/web-framework 3.0.3 의 타입 정의를 직접 확인하고 구현했다.
 *
 *   User.getAnonymousKey: (() => Promise<{ hash: string; type: 'HASH' }>) & {
 *     isSupported: () => boolean;
 *     MIN_TOSS_APP_VERSION: { android: '5.232.0'; ios: '5.232.0' };
 *   }
 *
 * 실패 시 문자열을 반환하지 않고 **throw** 한다.
 * (앱 버전 부족이면 UNSUPPORTED_APP_VERSION, 그 외 UNKNOWN_ERROR)
 *
 * 공통 01 §1: 로컬 브라우저와 토스/샌드박스 동작이 다르므로 환경 분기를 둔다.
 * 호스트 환경은 `Environment.environment` 로 확인한다.
 * `isSupported()` 는 앱 버전 지원 여부이므로 환경 판별에 사용하지 않는다.
 * MOCK 은 토스/샌드박스 밖의 개발 빌드에서만 허용하고 운영 빌드는 항상 실제 SDK 를 쓴다.
 */

const MOCK_KEY_STORAGE_HINT = 'hanguksa5min:MOCK-anon-key';

export interface IdentityAdapter {
  readonly name: string;
  getAnonymousKey(): Promise<string>;
}

/**
 * 실제 토스 환경 어댑터.
 *
 * anonKey 원문은 여기서 받아 bootstrap 요청 본문으로만 넘긴다.
 * 로그·URL·Analytics 어디에도 남기지 않는다 (공통 04 §4, 하드게이트 P0).
 */
export const tossIdentityAdapter: IdentityAdapter = {
  name: 'toss',
  async getAnonymousKey(): Promise<string> {
    const result = await User.getAnonymousKey();
    return result.hash;
  },
};

/**
 * 개발용 MOCK 어댑터.
 *
 * 토스/샌드박스 밖의 개발 빌드(로컬 브라우저)에서만 쓰인다.
 * 브라우저 세션 동안 같은 키를 유지해야 "재방문 사용자" 흐름을 확인할 수 있다.
 * 이 값은 개발용 식별키이지 토큰이 아니다. 실제 anonKey 와 내부 access token 은
 * 절대 웹 스토리지에 저장하지 않는다 (공통 02 §2).
 */
export const mockIdentityAdapter: IdentityAdapter = {
  name: 'MOCK',
  getAnonymousKey(): Promise<string> {
    const existing = sessionStorage.getItem(MOCK_KEY_STORAGE_HINT);
    if (existing != null && existing.length > 0) return Promise.resolve(existing);

    const created = `MOCK-dev-${crypto.randomUUID()}`;
    sessionStorage.setItem(MOCK_KEY_STORAGE_HINT, created);
    console.warn('[MOCK] 토스 환경이 아니라 개발용 식별키를 사용합니다.');
    return Promise.resolve(created);
  },
};

/** 앱 버전 지원 여부와 별개로 토스/샌드박스 호스트 안에서 실행 중인지. */
export function isTossEnvironment(): boolean {
  try {
    const environment = Environment.environment;
    return environment === 'toss' || environment === 'sandbox';
  } catch {
    // 로컬 브라우저에서는 호스트 상수가 없어 예외가 날 수 있다.
    return false;
  }
}

export function createIdentityAdapter(): IdentityAdapter {
  return import.meta.env.DEV && !isTossEnvironment() ? mockIdentityAdapter : tossIdentityAdapter;
}
