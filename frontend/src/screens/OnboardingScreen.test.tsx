import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App.tsx';
import type { ExamsResponse } from '../api/types.ts';

vi.mock('../auth/AuthProvider.tsx', () => ({
  useAuth: () => ({ status: 'authenticated' }),
}));
vi.mock('./HomeScreen.tsx', () => ({
  HomeScreen: () => <h1>테스트 홈</h1>,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('목표 저장 후 일정 재조회가 지연돼도 한 번에 홈으로 이동한다', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test.local');
  const exam = {
    id: 'exam-1',
    type: 'advanced',
    round: 80,
    examDate: '2026-10-17',
    status: 'scheduled',
    dday: 41,
    selectable: true,
  };
  const initial: ExamsResponse = {
    today: '2026-09-06',
    exams: [exam],
    goal: { targetGrade: null, exam: null, needsReselection: false },
  };
  let saved = false;
  let writes = 0;
  vi.stubGlobal('fetch', (input: string) => {
    if (String(input).includes('/profile/goal')) {
      saved = true;
      writes++;
      return Promise.resolve(
        Response.json({ goal: { targetGrade: 2, exam, needsReselection: false } }),
      );
    }
    // MOCK: 저장 후 재조회 응답을 보류해 기존 목표 캐시와 라우팅 간 경쟁을 재현한다.
    if (saved) return new Promise<Response>(() => {});
    return Promise.resolve(Response.json(initial));
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 10_000 } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole('radio', { name: /심화 2급/ }));
  await userEvent.click(screen.getByRole('radio', { name: /제80회 심화/ }));
  await userEvent.click(screen.getByRole('button', { name: '바로 시작하기' }));
  expect(await screen.findByRole('heading', { name: '테스트 홈' })).toBeTruthy();
  expect(writes).toBe(1);
  expect(screen.queryByRole('button', { name: '바로 시작하기' })).toBeNull();
  client.clear();
});
