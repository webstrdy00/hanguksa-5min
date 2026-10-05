import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/hooks.ts';
import type { CompleteResponse, SessionResponse } from '../api/types.ts';
import { ResultScreen } from './ResultScreen.tsx';

const { analytics } = vi.hoisted(() => ({
  analytics: { log: vi.fn(), screen: vi.fn() },
}));
vi.mock('@apps-in-toss/web-framework', () => ({ Analytics: analytics }));

function makeSession(completed = false): SessionResponse {
  return {
    session: {
      id: 'MOCK-session',
      studyDate: '2026-09-06',
      completedAt: completed ? '2026-09-06T10:00:00Z' : null,
      score: completed ? 4 : null,
      createdAt: '2026-09-06T09:00:00Z',
    },
    items: Array.from({ length: 5 }, (_, index) => ({
      slotIndex: index,
      slotSource: 'new',
      questionRevisionId: `MOCK-rev-${index}`,
      era: 'goryeo',
      topic: 'politics',
      difficulty: 2,
      prompt: `MOCK 문항 ${index}`,
      choices: ['가', '나', '다', '라', '마'],
      voided: false,
      answered: true,
      selectedIndex: index === 0 ? 1 : 0,
      correctIndex: 0,
      isCorrect: index !== 0,
      explanation: 'MOCK 해설',
    })),
  };
}

function makeComplete(alreadyCompleted = false): CompleteResponse {
  return {
    session: {
      id: 'MOCK-session',
      studyDate: '2026-09-06',
      score: 4,
      completedAt: '2026-09-06T10:00:00Z',
    },
    streak: { days: 3, lastStreakDate: '2026-09-06' },
    validCount: 5,
    alreadyCompleted,
  };
}

function renderScreen(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const view = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ResultScreen />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
  return { ...view, client };
}

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test.local');
  analytics.log.mockReset().mockResolvedValue(undefined);
  analytics.screen.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('결과 진입 시 완료를 한 번 요청하고 서버 점수와 연속일을 표시한다', async () => {
  const state = makeSession();
  let requests = 0;
  vi.stubGlobal('fetch', (input: string) => {
    if (!String(input).includes('/complete')) return Promise.resolve(Response.json(state));
    requests++;
    state.session = makeSession(true).session;
    return Promise.resolve(
      Response.json({
        session: state.session,
        streak: { days: 3, lastStreakDate: '2026-09-06' },
        validCount: 5,
        alreadyCompleted: false,
      }),
    );
  });
  const view = renderScreen();
  await screen.findByText('연속 학습 3일째');
  expect(screen.getByText('4')).toBeTruthy();
  expect(screen.getByText('/ 5')).toBeTruthy();
  expect(requests).toBe(1);
  await waitFor(() => expect(analytics.log).toHaveBeenCalledTimes(1));
  expect(analytics.log).toHaveBeenCalledWith({
    log_name: 'complete_daily_study',
    log_type: 'event',
    params: { score: '4', valid_count: '5', streak_days: '3' },
  });

  await act(async () => {
    await view.client.refetchQueries({ queryKey: queryKeys.session });
  });
  view.unmount();
  renderScreen(view.client);
  await screen.findByText('오늘의 결과');
  expect(requests).toBe(1);
  expect(analytics.log).toHaveBeenCalledTimes(1);
});

it('이미 완료한 결과에 재진입해도 완료를 다시 요청하지 않는다', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: string) => {
    calls.push(String(input));
    return Promise.resolve(Response.json(makeSession(true)));
  });
  renderScreen();
  await screen.findByText('오늘의 결과');
  expect(screen.getByText('4')).toBeTruthy();
  expect(calls.filter((url) => url.includes('/complete'))).toHaveLength(0);
  await waitFor(() =>
    expect(analytics.log).toHaveBeenCalledExactlyOnceWith({
      log_name: 'complete_daily_study',
      log_type: 'event',
      params: { score: '4', valid_count: '5' },
    }),
  );
});

it('오답이 복습 슬롯보다 많아도 모두 내일 출제된다고 약속하지 않는다', async () => {
  const state = makeSession(true);
  state.session.score = 0;
  state.items = state.items.map((item) => ({ ...item, selectedIndex: 1, isCorrect: false }));
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(state)));
  renderScreen();
  await screen.findByText(/5개를 틀렸어요/);
  expect(screen.getByText(/복습 일정에 따라 일부씩 다시 나와요/)).toBeTruthy();
  expect(screen.queryByText(/내일 복습 문제로 다시 만나요/)).toBeNull();
});

it('완료 저장 실패를 표시하고 재시도하면 서버 결과로 회복한다', async () => {
  let requests = 0;
  const state = makeSession();
  vi.stubGlobal('fetch', (input: string) => {
    if (!String(input).includes('/complete')) return Promise.resolve(Response.json(state));
    requests++;
    if (requests === 1) return Promise.reject(new Error('MOCK offline'));
    state.session = makeSession(true).session;
    return Promise.resolve(
      Response.json({
        session: state.session,
        streak: { days: 1, lastStreakDate: '2026-09-06' },
        validCount: 5,
        alreadyCompleted: false,
      }),
    );
  });
  renderScreen();
  await screen.findByRole('alert');
  expect(screen.queryByText('오늘의 결과')).toBeNull();
  expect(analytics.log).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByText('연속 학습 1일째');
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(requests).toBe(2);
  await waitFor(() => expect(analytics.log).toHaveBeenCalledTimes(1));
});

it('완료 저장 후 응답 유실은 권위 있는 재조회로 복구하며 완료 POST를 다시 보내지 않는다', async () => {
  const state = makeSession();
  let requests = 0;
  vi.stubGlobal('fetch', (input: string) => {
    if (!String(input).includes('/complete')) return Promise.resolve(Response.json(state));
    requests++;
    state.session = makeSession(true).session;
    return Promise.reject(new Error('MOCK response lost after commit'));
  });
  const view = renderScreen();
  await screen.findByRole('alert');
  expect(analytics.log).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByText('오늘의 결과');
  await waitFor(() =>
    expect(analytics.log).toHaveBeenCalledExactlyOnceWith({
      log_name: 'complete_daily_study',
      log_type: 'event',
      params: { score: '4', valid_count: '5' },
    }),
  );
  expect(requests).toBe(1);
  expect(screen.queryByRole('alert')).toBeNull();

  view.unmount();
  renderScreen(view.client);
  await screen.findByText('오늘의 결과');
  expect(analytics.log).toHaveBeenCalledTimes(1);
  expect(requests).toBe(1);
});

it('완료 POST의 alreadyCompleted 응답도 문서에서 미전달한 전환을 복구한다', async () => {
  const state = makeSession();
  let requests = 0;
  vi.stubGlobal('fetch', (input: string) => {
    if (!String(input).includes('/complete')) return Promise.resolve(Response.json(state));
    requests++;
    state.session = makeSession(true).session;
    return Promise.resolve(Response.json(makeComplete(true)));
  });
  renderScreen();
  await screen.findByText('연속 학습 3일째');
  await waitFor(() => expect(analytics.log).toHaveBeenCalledTimes(1));
  expect(requests).toBe(1);
});

it('SDK reject가 학습 결과를 막지 않고 같은 완료를 재조회하면 재시도한다', async () => {
  const state = makeSession();
  let rejectSdk!: (reason: Error) => void;
  analytics.log.mockReturnValueOnce(
    new Promise<void>((_, reject) => {
      rejectSdk = reject;
    }),
  );
  vi.stubGlobal('fetch', (input: string) => {
    if (!String(input).includes('/complete')) return Promise.resolve(Response.json(state));
    state.session = makeSession(true).session;
    return Promise.resolve(Response.json(makeComplete()));
  });
  const view = renderScreen();
  await screen.findByText('연속 학습 3일째');
  await waitFor(() =>
    expect(
      view.client.getQueryData<SessionResponse>(queryKeys.session)?.session.completedAt,
    ).not.toBeNull(),
  );
  expect(analytics.log).toHaveBeenCalledTimes(1);
  await act(async () => {
    rejectSdk(new Error('MOCK SDK rejected'));
  });
  expect(screen.getByText('오늘의 결과')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(analytics.log).toHaveBeenCalledTimes(1);

  await act(async () => {
    await view.client.refetchQueries({ queryKey: queryKeys.session });
  });
  await waitFor(() => expect(analytics.log).toHaveBeenCalledTimes(2));
  view.unmount();
  renderScreen(view.client);
  await screen.findByText('오늘의 결과');
  expect(analytics.log).toHaveBeenCalledTimes(2);
});

it('SDK reject 후 화면 재방문에서도 전환을 복구한다', async () => {
  const state = makeSession(true);
  analytics.log.mockRejectedValueOnce(new Error('MOCK SDK rejected'));
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(state)));
  const view = renderScreen();
  await screen.findByText('오늘의 결과');
  await waitFor(() => expect(analytics.log).toHaveBeenCalledTimes(1));
  view.unmount();
  renderScreen(view.client);
  await screen.findByText('오늘의 결과');
  await waitFor(() => expect(analytics.log).toHaveBeenCalledTimes(2));
});

it('완료 응답 전에 이탈해도 mutateAsync 전달은 살아 있고 재방문에서 중복하지 않는다', async () => {
  const state = makeSession();
  let requests = 0;
  let deliver!: (response: Response) => void;
  vi.stubGlobal('fetch', (input: string) => {
    if (!String(input).includes('/complete')) return Promise.resolve(Response.json(state));
    requests++;
    state.session = makeSession(true).session;
    return new Promise<Response>((resolve) => {
      deliver = resolve;
    });
  });
  const view = renderScreen();
  await waitFor(() => expect(requests).toBe(1));
  view.unmount();
  await act(async () => {
    deliver(Response.json(makeComplete()));
  });
  await waitFor(() => expect(analytics.log).toHaveBeenCalledTimes(1));
  expect(view.client.getQueryData<SessionResponse>(queryKeys.session)?.session).toEqual({
    ...makeSession().session,
    ...makeComplete().session,
  });

  renderScreen(view.client);
  await screen.findByText('오늘의 결과');
  expect(requests).toBe(1);
  expect(analytics.log).toHaveBeenCalledTimes(1);
});

it('다른 계정 세션으로 교체된 QueryClient에는 늦은 완료 응답을 전달하지 않는다', async () => {
  let state = makeSession();
  let requests = 0;
  let deliver!: (response: Response) => void;
  vi.stubGlobal('fetch', (input: string) => {
    if (!String(input).includes('/complete')) return Promise.resolve(Response.json(state));
    requests++;
    return new Promise<Response>((resolve) => {
      deliver = resolve;
    });
  });
  const view = renderScreen();
  await waitFor(() => expect(requests).toBe(1));
  view.unmount();
  state = makeSession(true);
  state.session.id = 'MOCK-new-account-session';
  view.client.setQueryData(queryKeys.session, state);
  await act(async () => {
    deliver(Response.json(makeComplete()));
  });
  await waitFor(() =>
    expect(view.client.getMutationCache().getAll()[0]?.state.status).toBe('success'),
  );
  expect(view.client.getQueryData<SessionResponse>(queryKeys.session)).toEqual(state);
  expect(analytics.log).not.toHaveBeenCalled();

  renderScreen(view.client);
  await screen.findByText('오늘의 결과');
  await waitFor(() => expect(analytics.log).toHaveBeenCalledTimes(1));
  expect(requests).toBe(1);
});

it('미답 유효 문항이 있으면 완료 요청과 전환 모두 보내지 않는다', async () => {
  const state = makeSession();
  state.items[4]!.answered = false;
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: string) => {
    calls.push(String(input));
    return Promise.resolve(Response.json(state));
  });
  renderScreen();
  await screen.findByText('오늘의 결과');
  expect(calls.filter((url) => url.includes('/complete'))).toHaveLength(0);
  expect(analytics.log).not.toHaveBeenCalled();
});

it('무효 미답 문항은 완료를 막지 않고 유효 문항 수만 전송한다', async () => {
  const state = makeSession();
  state.items[4] = { ...state.items[4]!, voided: true, answered: false };
  const response = { ...makeComplete(), validCount: 4 };
  vi.stubGlobal('fetch', (input: string) => {
    if (!String(input).includes('/complete')) return Promise.resolve(Response.json(state));
    state.session = makeSession(true).session;
    return Promise.resolve(Response.json(response));
  });
  renderScreen();
  await screen.findByText('연속 학습 3일째');
  await waitFor(() =>
    expect(analytics.log).toHaveBeenCalledExactlyOnceWith({
      log_name: 'complete_daily_study',
      log_type: 'event',
      params: { score: '4', valid_count: '4', streak_days: '3' },
    }),
  );
});
