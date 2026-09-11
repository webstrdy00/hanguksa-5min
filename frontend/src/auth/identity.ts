import { User } from '@apps-in-toss/web-framework';

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
 * `isSupported()` 가 그 분기점이다. 로컬 브라우저에서는 MOCK 으로 떨어진다.
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
 * 토스 WebView 밖(로컬 브라우저)에서만 쓰인다.
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

/** 토스 앱 안에서 실행 중이고 SDK 가 이 기능을 지원하는지. */
export function isTossEnvironment(): boolean {
  try {
    return User.getAnonymousKey.isSupported();
  } catch {
    // 로컬 브라우저에서는 브릿지가 없어 예외가 날 수 있다.
    return false;
  }
}

export function createIdentityAdapter(): IdentityAdapter {
  return isTossEnvironment() ? tossIdentityAdapter : mockIdentityAdapter;
}
