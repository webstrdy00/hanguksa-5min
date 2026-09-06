import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionResponse } from '../api/types.ts';
import { ResultScreen } from './ResultScreen.tsx';

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
        <MemoryRouter>
          <ResultScreen />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
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
