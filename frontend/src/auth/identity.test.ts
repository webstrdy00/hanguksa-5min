import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createIdentityAdapter,
  isTossEnvironment,
  mockIdentityAdapter,
  tossIdentityAdapter,
} from './identity.ts';

const { getEnvironment, getAnonymousKey, isSupported } = vi.hoisted(() => ({
  getEnvironment:
    vi.fn<() => typeof import('@apps-in-toss/web-framework').Environment.environment | undefined>(),
  getAnonymousKey: vi.fn<typeof import('@apps-in-toss/web-framework').User.getAnonymousKey>(),
  isSupported:
    vi.fn<typeof import('@apps-in-toss/web-framework').User.getAnonymousKey.isSupported>(),
}));
vi.mock('@apps-in-toss/web-framework', () => ({
  Environment: {
    get environment() {
      return getEnvironment();
    },
  },
  User: { getAnonymousKey: Object.assign(getAnonymousKey, { isSupported }) },
}));

const environments = ['toss', 'sandbox', undefined, 'throws'] as const;
const supportStates = [true, false, 'throws'] as const;

function setEnvironment(environment: (typeof environments)[number]) {
  if (environment === 'throws') {
    getEnvironment.mockImplementation(() => {
      throw new Error('MOCK host constants unavailable');
    });
  } else {
    getEnvironment.mockReturnValue(environment);
  }
}

function setSupport(supported: (typeof supportStates)[number]) {
  if (supported === 'throws') {
    isSupported.mockImplementation(() => {
      throw new Error('MOCK SDK support check unavailable');
    });
  } else {
    isSupported.mockReturnValue(supported);
  }
}

beforeEach(() => {
  vi.stubEnv('DEV', false);
  sessionStorage.clear();
  getEnvironment.mockReset().mockReturnValue(undefined);
  getAnonymousKey.mockReset().mockResolvedValue({ hash: 'MOCK-sdk-hash', type: 'HASH' });
  isSupported.mockReset().mockReturnValue(false);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllEnvs();
});

it.each(environments)('호스트 환경 %s를 앱 버전 지원 여부와 별개로 판별한다', (environment) => {
  setEnvironment(environment);
  setSupport('throws');
  expect(isTossEnvironment()).toBe(environment === 'toss' || environment === 'sandbox');
  expect(isSupported).not.toHaveBeenCalled();
});

it.each(
  environments.flatMap((environment) =>
    supportStates.map((supported) => ({ environment, supported })),
  ),
)(
  '운영 빌드는 환경 $environment / SDK 지원 $supported 에서 실제 SDK 를 쓴다',
  async ({ environment, supported }) => {
    setEnvironment(environment);
    setSupport(supported);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');

    const adapter = createIdentityAdapter();
    expect(adapter).toBe(tossIdentityAdapter);
    await expect(adapter.getAnonymousKey()).resolves.toBe('MOCK-sdk-hash');
    expect(getAnonymousKey).toHaveBeenCalledTimes(1);
    expect(getEnvironment).not.toHaveBeenCalled();
    expect(isSupported).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  },
);

it.each(supportStates)(
  '개발 브라우저는 SDK 지원 %s와 무관하게 명시적 MOCK 키를 세션 동안 유지한다',
  async (supported) => {
    vi.stubEnv('DEV', true);
    setSupport(supported);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');

    const adapter = createIdentityAdapter();
    expect(adapter).toBe(mockIdentityAdapter);
    const key = await adapter.getAnonymousKey();
    expect(key).toMatch(/^MOCK-dev-/);
    await expect(adapter.getAnonymousKey()).resolves.toBe(key);
    expect(storageWrite).toHaveBeenCalledExactlyOnceWith('hanguksa5min:MOCK-anon-key', key);
    expect(getAnonymousKey).not.toHaveBeenCalled();
    expect(isSupported).not.toHaveBeenCalled();
  },
);

it.each(
  (['toss', 'sandbox'] as const).flatMap((environment) =>
    supportStates.map((supported) => ({ environment, supported })),
  ),
)(
  '개발 $environment 는 SDK 지원 $supported 에도 MOCK 으로 바꾸지 않는다',
  async ({ environment, supported }) => {
    vi.stubEnv('DEV', true);
    setEnvironment(environment);
    setSupport(supported);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');

    const adapter = createIdentityAdapter();
    expect(adapter).toBe(tossIdentityAdapter);
    await expect(adapter.getAnonymousKey()).resolves.toBe('MOCK-sdk-hash');
    expect(isSupported).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  },
);

it.each([true, false])('환경 getter 예외는 개발 빌드 %s에서만 MOCK 을 허용한다', (development) => {
  vi.stubEnv('DEV', development);
  setEnvironment('throws');

  expect(createIdentityAdapter()).toBe(development ? mockIdentityAdapter : tossIdentityAdapter);
  expect(isSupported).not.toHaveBeenCalled();
});

it.each([
  { development: false, environment: undefined },
  { development: false, environment: 'throws' },
  { development: false, environment: 'toss' },
  { development: false, environment: 'sandbox' },
  { development: true, environment: 'toss' },
  { development: true, environment: 'sandbox' },
] as const)(
  '개발 $development / 환경 $environment 의 실제 SDK 실패는 저장된 MOCK 으로 복구하지 않는다',
  async ({ development, environment }) => {
    vi.stubEnv('DEV', development);
    setEnvironment(environment);
    sessionStorage.setItem('hanguksa5min:MOCK-anon-key', 'MOCK-existing-dev-key');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const failure = new Error('MOCK SDK unavailable');
    getAnonymousKey.mockRejectedValue(failure);

    const adapter = createIdentityAdapter();
    expect(adapter).toBe(tossIdentityAdapter);
    await expect(adapter.getAnonymousKey()).rejects.toBe(failure);
    expect(createIdentityAdapter()).toBe(tossIdentityAdapter);
    await expect(adapter.getAnonymousKey()).rejects.toBe(failure);
    expect(getAnonymousKey).toHaveBeenCalledTimes(2);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  },
);

it('실제 SDK 의 hash 만 반환하고 키를 로그나 웹 스토리지에 남기지 않는다', async () => {
  const logs = (['debug', 'info', 'log', 'warn', 'error'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
  getAnonymousKey.mockResolvedValueOnce({ hash: 'MOCK-sdk-result-hash', type: 'HASH' });

  await expect(tossIdentityAdapter.getAnonymousKey()).resolves.toBe('MOCK-sdk-result-hash');
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(storageWrite).not.toHaveBeenCalled();
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
