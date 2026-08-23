/**
 * 앱인토스 사용자 식별키 획득 (공통 06 §1 1단계).
 *
 * ⚠️ 현재는 개발용 MOCK 이다.
 *
 * 실제 SDK 호출(`User.getAnonymousKey`)은 9단계에서 붙인다.
 * 그때 설치된 @apps-in-toss/web-framework 3.0.3 의 타입 정의를 직접 확인하고 구현한다.
 * 지금 추측으로 함수명을 적어두면 나중에 조용히 틀린 채로 남는다 (AGENTS.md §8).
 *
 * 공통 01 §1: 로컬 브라우저와 토스/샌드박스 동작이 다르므로 SDK 호출에 환경 분기를 둔다.
 * 이 파일이 그 분기점이다. 화면 코드는 이 함수만 부르면 된다.
 */

const MOCK_KEY_STORAGE_HINT = 'hanguksa5min:MOCK-anon-key';

/**
 * MOCK 식별키를 만든다.
 *
 * 브라우저 세션 동안 같은 키를 유지해야 "재방문 사용자"를 테스트할 수 있다.
 * 토큰이 아니라 **개발용 식별키**이므로 sessionStorage 를 써도 보안 문제가 아니다.
 * 실제 anonKey 와 내부 access token 은 절대 스토리지에 저장하지 않는다.
 */
function getMockAnonymousKey(): string {
  const existing = sessionStorage.getItem(MOCK_KEY_STORAGE_HINT);
  if (existing != null && existing.length > 0) return existing;

  const created = `MOCK-dev-${crypto.randomUUID()}`;
  sessionStorage.setItem(MOCK_KEY_STORAGE_HINT, created);
  return created;
}

export interface IdentityAdapter {
  readonly name: string;
  getAnonymousKey(): Promise<string>;
}

/** 개발/로컬 브라우저용. 9단계에서 실제 SDK 어댑터로 교체한다. */
export const mockIdentityAdapter: IdentityAdapter = {
  name: 'MOCK',
  getAnonymousKey(): Promise<string> {
    console.warn('[MOCK] 실제 앱인토스 식별키가 아닙니다. 9단계에서 SDK 를 연결합니다.');
    return Promise.resolve(getMockAnonymousKey());
  },
};

export function createIdentityAdapter(): IdentityAdapter {
  // 9단계에서 토스 WebView 환경을 감지해 실제 SDK 어댑터를 돌려주도록 확장한다.
  return mockIdentityAdapter;
}
