import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App.tsx';
import * as apiClient from '../api/client.ts';
import { ApiError, request, setAccessToken } from '../api/client.ts';
import { ErrorState } from '../components/common.tsx';
import { AuthProvider } from './AuthProvider.tsx';
import { AuthInitializationError } from './errors.ts';

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
  vi.restoreAllMocks();
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

it.each(['throw', 'reject', '503', 'NetworkError'])(
  'SDK %s는 원문 없이 식별 실패로 분류하고 회복한다',
  async (mode) => {
    vi.useFakeTimers();
    const message = 'MOCK SDK secret: anonKey=MOCK-private-key token=MOCK-private-token';
    let sensitiveError: Error = new Error(message);
    if (mode === '503') {
      sensitiveError = new ApiError(503, {
        code: 'MOCK_SDK_ERROR',
        message,
        retryable: true,
        requestId: 'MOCK-private-key',
      });
    } else if (mode === 'NetworkError') {
      sensitiveError = new apiClient.NetworkError();
    }
    if (mode === 'throw') {
      getAnonymousKey.mockImplementationOnce(() => {
        throw sensitiveError;
      });
    } else {
      getAnonymousKey.mockRejectedValueOnce(sensitiveError);
    }
    const fetchMock = vi.fn(successfulFetch);
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      '토스 사용자 식별 정보를 확인할 수 없어요. 잠시 후 다시 시도해주세요. (AUTH_IDENTITY_FAILED)',
    );
    expect(alert.textContent).not.toContain('MOCK');
    expect(screen.queryByRole('heading', { name: 'MOCK 인증된 홈' })).toBeNull();
    expect(getAnonymousKey).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await screen.findByRole('heading', { name: 'MOCK 인증된 홈' });
    expect(getAnonymousKey).toHaveBeenCalledTimes(2);
  },
);

it.each([
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: '빈 문자열', value: '' },
  { label: '공백 문자열', value: ' \t\n' },
  { label: '숫자', value: 123 },
  { label: '불리언', value: false },
  { label: '객체', value: { hash: 'MOCK-private-key' } },
  { label: '배열', value: ['MOCK-private-key'] },
])('$label 식별키는 HTTP 요청 없이 실패하고 이전 토큰을 지운다', async ({ value }) => {
  vi.useFakeTimers();
  setAccessToken('MOCK-stale-token');
  getAnonymousKey.mockResolvedValueOnce(value);
  const fetchMock = vi.fn().mockImplementation(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.getByRole('alert').textContent).toContain('(AUTH_IDENTITY_FAILED)');
  expect(screen.getByRole('alert').textContent).not.toContain('MOCK');
  expect(screen.queryByRole('heading', { name: 'MOCK 인증된 홈' })).toBeNull();
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
  await request('/v1/MOCK-token-check');
  expect(fetchMock.mock.calls[0]?.[1].headers.authorization).toBeUndefined();
});

it.each([
  {
    label: '잘못된 JSON',
    response: () => new Response('{"accessToken":"MOCK-private-token"', { status: 200 }),
  },
  {
    label: '본문 읽기 오류',
    response: () => {
      const response = new Response();
      vi.spyOn(response, 'json').mockRejectedValue(
        new Error('MOCK-private-key MOCK-private-token'),
      );
      return response;
    },
  },
  { label: '빈 본문', response: () => new Response('', { status: 200 }) },
  { label: '204', response: () => new Response(null, { status: 204 }) },
  { label: 'null', response: () => Response.json(null) },
  { label: '숫자', response: () => Response.json(123) },
  { label: '문자열', response: () => Response.json('MOCK-private-token') },
  { label: '배열', response: () => Response.json([{ accessToken: 'MOCK-private-token' }]) },
  { label: '누락된 토큰', response: () => Response.json({}) },
  { label: 'null 토큰', response: () => Response.json({ accessToken: null }) },
  { label: '빈 토큰', response: () => Response.json({ accessToken: '' }) },
  { label: '숫자 토큰', response: () => Response.json({ accessToken: 123 }) },
  {
    label: '객체 토큰',
    response: () => Response.json({ accessToken: { token: 'MOCK-private-token' } }),
  },
  { label: '배열 토큰', response: () => Response.json({ accessToken: ['MOCK-private-token'] }) },
  { label: '공백 토큰', response: () => Response.json({ accessToken: ' \t\n' }) },
  { label: '앞 공백 토큰', response: () => Response.json({ accessToken: ' MOCK-private-token' }) },
  { label: '뒤 공백 토큰', response: () => Response.json({ accessToken: 'MOCK-private-token ' }) },
  { label: '중간 공백 토큰', response: () => Response.json({ accessToken: 'MOCK private-token' }) },
  { label: '개행 토큰', response: () => Response.json({ accessToken: 'MOCK-private-token\n' }) },
  { label: '탭 토큰', response: () => Response.json({ accessToken: 'MOCK\tprivate-token' }) },
  { label: 'NUL 토큰', response: () => Response.json({ accessToken: 'MOCK\u0000private-token' }) },
  { label: 'DEL 토큰', response: () => Response.json({ accessToken: 'MOCK\u007fprivate-token' }) },
  { label: '비 ASCII 토큰', response: () => Response.json({ accessToken: 'MOCK-한글-token' }) },
])('$label 성공 응답은 토큰 설치나 자동 재시도 없이 안전하게 실패한다', async ({ response }) => {
  vi.useFakeTimers();
  setAccessToken('MOCK-stale-token');
  const fetchMock = vi.fn().mockResolvedValueOnce(response()).mockImplementation(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain(
    '인증 서버의 응답을 확인할 수 없어요. 잠시 후 다시 시도해주세요. (AUTH_RESPONSE_INVALID)',
  );
  expect(alert.textContent).not.toContain('MOCK');
  expect(screen.queryByRole('heading', { name: 'MOCK 인증된 홈' })).toBeNull();
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await request('/v1/MOCK-token-check');
  expect(fetchMock.mock.calls[1]?.[1].headers.authorization).toBeUndefined();
  vi.useRealTimers();
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByRole('heading', { name: 'MOCK 인증된 홈' });
});

it('예상하지 못한 bootstrap 예외는 원문 없이 단계 오류로 바꾸고 수동 재시도로 회복한다', async () => {
  vi.useFakeTimers();
  const requestSpy = vi
    .spyOn(apiClient, 'request')
    .mockRejectedValueOnce(new Error('MOCK-bootstrap-secret: MOCK-private-key MOCK-private-token'));
  const fetchMock = vi.fn(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain(
    '인증을 완료할 수 없어요. 잠시 후 다시 시도해주세요. (AUTH_BOOTSTRAP_FAILED)',
  );
  expect(alert.textContent).not.toContain('MOCK');
  expect(screen.queryByRole('heading', { name: 'MOCK 인증된 홈' })).toBeNull();
  expect(requestSpy).toHaveBeenCalledTimes(1);
  expect(getAnonymousKey).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
  requestSpy.mockRestore();
  vi.useRealTimers();
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByRole('heading', { name: 'MOCK 인증된 홈' });
});

it('인증 오류는 원본 원인 없이 고정된 안전 메시지를 렌더링한다', () => {
  const error = new AuthInitializationError('AUTH_IDENTITY_FAILED');
  render(<ErrorState error={error} />);
  expect(error).not.toHaveProperty('cause');
  expect(Object.keys(error).sort()).toEqual(['code', 'name']);
  expect(screen.getByRole('alert').textContent).toContain(
    '토스 사용자 식별 정보를 확인할 수 없어요. 잠시 후 다시 시도해주세요. (AUTH_IDENTITY_FAILED)',
  );
});

it('알 수 없는 Error의 민감한 message는 공통 오류 UI에 노출하지 않는다', () => {
  render(<ErrorState error={new Error('MOCK-secret: MOCK-private-key MOCK-private-token')} />);
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('알 수 없는 오류가 발생했어요.');
  expect(alert.textContent).not.toContain('MOCK');
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

it('unmount 후 늦게 받은 식별키는 bootstrap을 보내거나 현재 토큰을 지우지 않는다', async () => {
  vi.useFakeTimers();
  let resolveKey: ((value: string) => void) | undefined;
  getAnonymousKey.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        resolveKey = resolve;
      }),
  );
  const fetchMock = vi.fn().mockImplementation(successfulFetch);
  vi.stubGlobal('fetch', fetchMock);
  const view = renderApp();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  view.unmount();
  setAccessToken('MOCK-current-token');
  await act(async () => {
    resolveKey?.('MOCK-late-key');
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await request('/v1/MOCK-token-check');
  expect(fetchMock.mock.calls[0]?.[1].headers.authorization).toBe('Bearer MOCK-current-token');
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
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain(
    mode === 'SDK'
      ? '토스 사용자 식별 정보 확인이 늦어지고 있어요. 잠시 후 다시 시도해주세요. (AUTH_IDENTITY_TIMEOUT)'
      : '서버 응답이 늦어지고 있어요.',
  );
  if (mode === 'HTTP') expect(alert.textContent).not.toContain('AUTH_IDENTITY_TIMEOUT');
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
