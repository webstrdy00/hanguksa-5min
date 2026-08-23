/**
 * 프론트엔드 테스트 setup.
 *
 * jsdom 에 없는 브라우저 API 만 최소로 채운다.
 * 실제 동작을 흉내 내는 것이 목적이 아니라 렌더링이 깨지지 않게 하는 것이 목적이다.
 */
if (typeof globalThis.matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

if (typeof globalThis.scrollTo !== 'function') {
  Object.defineProperty(globalThis, 'scrollTo', { writable: true, value: () => undefined });
}
