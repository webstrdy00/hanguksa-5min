import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionResponse } from '../api/types.ts';
import { trackComplete } from '../analytics/events.ts';
import { ResultScreen } from './ResultScreen.tsx';

vi.mock('../analytics/events.ts', () => ({
  trackScreen: vi.fn(),
  trackComplete: vi.fn(),
}));

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

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/result']}>
          <Routes>
            <Route path="/result" element={<ResultScreen />} />
            <Route path="/study" element={<h1>테스트 학습 화면</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_API_BASE_URL', 'http://test.local');
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
  renderScreen();
  await screen.findByText('연속 학습 3일째');
  expect(screen.getByText('4')).toBeTruthy();
  expect(screen.getByText('/ 5')).toBeTruthy();
  expect(requests).toBe(1);
  expect(trackComplete).toHaveBeenCalledExactlyOnceWith('daily_study', {
    score: 4,
    valid_count: 5,
    streak_days: 3,
  });
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
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByText('연속 학습 1일째');
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(requests).toBe(2);
});

it('미완료 학습으로 결과에 직접 진입하면 완료 요청 없이 이어 풀기를 안내한다', async () => {
  const state = makeSession();
  state.items[4]!.answered = false;
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: string) => {
    calls.push(String(input));
    if (String(input).includes('/complete')) {
      return Promise.resolve(
        Response.json(
          {
            code: 'SESSION_INCOMPLETE',
            message: '모든 문제를 먼저 풀어주세요.',
            retryable: false,
            requestId: 'MOCK-request',
          },
          { status: 409 },
        ),
      );
    }
    return Promise.resolve(Response.json(state));
  });
  renderScreen();
  await screen.findByText('아직 풀지 않은 문제가 있어요');
  expect(screen.getByRole('button', { name: '이어서 풀기' })).toBeTruthy();
  expect(screen.queryByText('오늘의 결과')).toBeNull();
  expect(calls.filter((url) => url.includes('/complete'))).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '이어서 풀기' }));
  expect(await screen.findByRole('heading', { name: '테스트 학습 화면' })).toBeTruthy();
});

it('모든 문항이 무효이면 만점 대신 채점할 문항이 없다고 안내한다', async () => {
  const state = makeSession(true);
  state.session.score = 0;
  state.items = state.items.map((item) => ({ ...item, voided: true, answered: false }));
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(state)));
  renderScreen();
  await screen.findByText('오늘은 채점할 문항이 없어요. 내일 새로운 문제로 이어갈게요.');
  expect(screen.queryByText(/오늘은 모두 맞혔어요/)).toBeNull();
});

it('서버에서 이미 완료된 요청을 재응답해도 전환을 중복 기록하지 않는다', async () => {
  const state = makeSession();
  vi.stubGlobal('fetch', (input: string) => {
    if (!String(input).includes('/complete')) return Promise.resolve(Response.json(state));
    state.session = makeSession(true).session;
    return Promise.resolve(
      Response.json({
        session: state.session,
        streak: { days: 3, lastStreakDate: '2026-09-06' },
        validCount: 5,
        alreadyCompleted: true,
      }),
    );
  });
  renderScreen();
  await screen.findByText('연속 학습 3일째');
  expect(trackComplete).not.toHaveBeenCalled();
});
