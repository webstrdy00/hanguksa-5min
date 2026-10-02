import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App.tsx';
import { ApiError, request, setAccessToken } from '../api/client.ts';
import { AuthProvider } from './AuthProvider.tsx';

const { getAnonymousKey } = vi.hoisted(() => ({ getAnonymousKey: vi.fn() }));
vi.mock('./identity.ts', () => ({
  createIdentityAdapter: () => ({ name: 'MOCK', getAnonymousKey }),
}));
vi.mock('../screens/HomeScreen.tsx', () => ({
  HomeScreen: () => <h1>MOCK 인증된 홈</h1>,
}));

let client: QueryClient;
function renderApp() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StrictMode>
          <AuthProvider>
            <App />
          </AuthProvider>
        </StrictMode>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function successfulFetch(input: string) {
  return Promise.resolve(
    Response.json(
      String(input).includes('/bootstrap')
        ? { accessToken: 'MOCK-access-token', expiresIn: 1800, tokenType: 'Bearer' }
        : { goal: { targetGrade: 2, exam: null, needsReselection: true }, exams: [] },
    ),
  );
}

function bootstrapFailure(status: number) {
  return Response.json(
    {
      code: status === 401 ? 'INVALID_USER_KEY' : 'IDENTITY_PROVIDER_UNAVAILABLE',
      message:
        status === 401 ? '사용자 식별키를 확인할 수 없어요.' : '인증 서버에 잠시 연결할 수 없어요.',
      retryable: true,
      requestId: 'MOCK',
    },
    { status },
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test.local');
  getAnonymousKey.mockReset().mockResolvedValue('MOCK-anonymous-key');
});

afterEach(() => {
  cleanup();
  client?.clear();
  setAccessToken(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('네트워크 실패는 자동 재시도하지 않고 수동 재시도로 회복한다', async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error('MOCK offline'))
    .mockImplementation(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('네트워크에 연결할 수 없어요.');
  expect(alert.textContent).not.toContain('알 수 없는 오류');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByRole('heading', { name: 'MOCK 인증된 홈' });
});

it.each([429, 503])('%s는 같은 식별키로 1초, 2초 후 재시도해 자동 회복한다', async (status) => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(bootstrapFailure(status))
    .mockResolvedValueOnce(bootstrapFailure(status))
    .mockImplementation(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status').textContent).toContain('준비하고 있어요');
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_999);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(screen.getByRole('heading', { name: 'MOCK 인증된 홈' })).toBeTruthy();
  const bootstrapCalls = fetchMock.mock.calls.filter(([input]) =>
    String(input).includes('/bootstrap'),
  );
  expect(bootstrapCalls).toHaveLength(3);
  for (const [, init] of bootstrapCalls) {
    expect(init.body).toBe(JSON.stringify({ anonKey: 'MOCK-anonymous-key' }));
    expect(init.headers.authorization).toBeUndefined();
  }
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each([429, 503])('%s가 계속되면 세 번만 요청하고 수동 재시도를 허용한다', async (status) => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<(input: string) => Promise<Response>>(() =>
    Promise.resolve(bootstrapFailure(status)),
  );
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_999);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByRole('alert').textContent).toContain('인증 서버에 잠시 연결할 수 없어요.');
  expect(screen.queryByText('준비하고 있어요')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  fetchMock.mockImplementation(successfulFetch);
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByRole('heading', { name: 'MOCK 인증된 홈' });
  expect(getAnonymousKey).toHaveBeenCalledTimes(2);
  expect(
    fetchMock.mock.calls.filter(([input]) => String(input).includes('/bootstrap')),
  ).toHaveLength(4);
});

it.each([400, 401, 403, 409, 422, 500, 502, 504])(
  '%s는 retryable 표시와 관계없이 자동 재시도하지 않고 이전 토큰을 지운다',
  async (status) => {
    vi.useFakeTimers();
    setAccessToken('MOCK-stale-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bootstrapFailure(status))
      .mockImplementation(successfulFetch);
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByRole('alert').textContent).toContain(
      status === 401 ? '사용자 식별키를 확인할 수 없어요.' : '인증 서버에 잠시 연결할 수 없어요.',
    );
    expect(screen.queryByRole('heading', { name: 'MOCK 인증된 홈' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAnonymousKey).toHaveBeenCalledTimes(1);
    await request('/v1/MOCK-token-check');
    expect(fetchMock.mock.calls[1]?.[1].headers.authorization).toBeUndefined();
  },
);

it('503 재시도 중 무효한 식별키 401을 받으면 즉시 안전하게 실패한다', async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(bootstrapFailure(503))
    .mockResolvedValueOnce(bootstrapFailure(401))
    .mockImplementation(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.getByRole('alert').textContent).toContain('사용자 식별키를 확인할 수 없어요.');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  await request('/v1/MOCK-token-check');
  expect(fetchMock.mock.calls[2]?.[1].headers.authorization).toBeUndefined();
});

it('SDK 식별키 획득 실패는 재시도하거나 bootstrap 요청을 보내지 않는다', async () => {
  vi.useFakeTimers();
  getAnonymousKey.mockRejectedValueOnce(new Error('MOCK SDK unavailable'));
  const fetchMock = vi.fn(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.getByRole('alert').textContent).toContain('알 수 없는 오류가 발생했어요.');
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('StrictMode 초기 인증과 동시 401 재인증은 대기 중인 bootstrap을 공유한다', async () => {
  vi.useFakeTimers();
  let bootstrapAttempts = 0;
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input.includes('/bootstrap')) {
      bootstrapAttempts += 1;
      if (bootstrapAttempts === 1) return Promise.resolve(bootstrapFailure(503));
    }
    if (input.includes('/v1/MOCK-')) {
      return Promise.resolve(
        new Headers(init?.headers).get('authorization') === 'Bearer MOCK-access-token'
          ? Response.json({ ok: true })
          : bootstrapFailure(401),
      );
    }
    return successfulFetch(input);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const concurrent = [request('/v1/MOCK-first'), request('/v1/MOCK-second')];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(bootstrapAttempts).toBe(1);
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status').textContent).toContain('준비하고 있어요');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  await expect(Promise.all(concurrent)).resolves.toEqual([{ ok: true }, { ok: true }]);
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(screen.getByRole('heading', { name: 'MOCK 인증된 홈' })).toBeTruthy();
  expect(bootstrapAttempts).toBe(2);
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.filter(([input]) => input.includes('/v1/MOCK-'))).toHaveLength(4);
});

it('재시도 대기 중 unmount하면 타이머를 해제하고 추가 요청을 보내지 않는다', async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(bootstrapFailure(503))
    .mockImplementation(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  const view = renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  fetchMock.mockResolvedValueOnce(bootstrapFailure(401));
  await expect(request('/v1/MOCK-after-unmount')).rejects.toBeInstanceOf(ApiError);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('unmount 후 늦게 도착한 bootstrap 응답은 현재 토큰을 덮어쓰지 않는다', async () => {
  vi.useFakeTimers();
  let resolveResponse: ((value: Response) => void) | undefined;
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    )
    .mockImplementation(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  const view = renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  view.unmount();
  setAccessToken('MOCK-current-token');
  await act(async () => {
    resolveResponse?.(Response.json({ accessToken: 'MOCK-late-token' }));
    await vi.advanceTimersByTimeAsync(0);
  });
  await request('/v1/MOCK-token-check');
  expect(fetchMock.mock.calls[1]?.[1].headers.authorization).toBe('Bearer MOCK-current-token');
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['SDK', 'HTTP'])('%s 무응답 후 재시도하며 늦은 이전 응답은 무시한다', async (mode) => {
  vi.useFakeTimers();
  let resolveKey: ((value: string) => void) | undefined;
  let resolveResponse: ((value: Response) => void) | undefined;
  const fetchMock = vi.fn(successfulFetch);
  if (mode === 'SDK') {
    getAnonymousKey.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveKey = resolve;
        }),
    );
  } else {
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(screen.getByRole('alert').textContent).toContain('서버 응답이 늦어지고 있어요.');
  expect(screen.queryByText('준비하고 있어요')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(mode === 'SDK' ? 0 : 1);
  vi.useRealTimers();
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByRole('heading', { name: 'MOCK 인증된 홈' });
  const calls = fetchMock.mock.calls.length;
  await act(async () => {
    resolveKey?.('MOCK-late-key');
    resolveResponse?.(Response.json({ accessToken: 'MOCK-late-token' }));
  });
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('heading', { name: 'MOCK 인증된 홈' })).toBeTruthy();
});
