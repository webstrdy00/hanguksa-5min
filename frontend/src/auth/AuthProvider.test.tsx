import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App.tsx';
import { setAccessToken } from '../api/client.ts';
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
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
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

it.each(['offline', '503'])(
  '%s 인증 실패의 구체적인 메시지를 보여주고 재시도로 회복한다',
  async (mode) => {
    const fetchMock = vi.fn();
    if (mode === 'offline') fetchMock.mockRejectedValueOnce(new Error('MOCK offline'));
    else {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          {
            code: 'IDENTITY_PROVIDER_UNAVAILABLE',
            message: '인증 서버에 잠시 연결할 수 없어요.',
            retryable: true,
            requestId: 'MOCK',
          },
          { status: 503 },
        ),
      );
    }
    fetchMock.mockImplementation(successfulFetch);
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      mode === 'offline' ? '네트워크에 연결할 수 없어요.' : '인증 서버에 잠시 연결할 수 없어요.',
    );
    expect(alert.textContent).not.toContain('알 수 없는 오류');
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await screen.findByRole('heading', { name: 'MOCK 인증된 홈' });
  },
);

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
