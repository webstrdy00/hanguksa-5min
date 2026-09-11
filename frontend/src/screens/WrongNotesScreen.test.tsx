import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { WrongNoteItem } from '../api/types.ts';
import { WrongNotesScreen } from './WrongNotesScreen.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([0, 4])('서버가 알려준 선택지 %i를 정답·나머지 보기와 구분한다', async (selectedIndex) => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test.local');
  const item: WrongNoteItem = {
    canonicalQuestionId: 'MOCK-question',
    questionRevisionId: 'MOCK-revision',
    era: 'goryeo',
    topic: 'politics',
    difficulty: 2,
    prompt: 'MOCK 오답노트 문항',
    choices: ['보기 가', '보기 나', '보기 다', '보기 라', '보기 마'],
    correctIndex: 2,
    selectedIndex,
    explanation: 'MOCK 해설',
    memoryKeyword: null,
    wrongCount: 1,
    intervalStep: 1,
    reviewDueAt: '2026-09-07T00:00:00Z',
    lastSeenAt: '2026-09-06T00:00:00Z',
    lastReviewedAt: null,
    reviewed: false,
    retired: false,
  };
  vi.stubGlobal('fetch', () =>
    Promise.resolve(Response.json({ items: [item], page: 1, limit: 50, total: 1 })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WrongNotesScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '해설 보기' }));
  const selected = screen.getByText(`${item.choices[selectedIndex]} (내 선택)`);
  const correct = screen.getByText('보기 다 (정답)');
  const other = screen.getByText('보기 나');
  expect(selected.style.backgroundColor).toBe('rgb(255, 245, 245)');
  expect(selected.style.borderColor).toBe('rgb(194, 57, 52)');
  expect(selected.style.color).toBe('rgb(194, 57, 52)');
  expect(correct.style.backgroundColor).toBe('rgb(240, 246, 255)');
  expect(correct.style.borderColor).toBe('rgb(27, 100, 218)');
  expect(other.style.backgroundColor).toBe('rgb(255, 255, 255)');
  expect(other.style.fontWeight).toBe('400');
  expect(screen.queryAllByText(/\(내 선택\)/)).toHaveLength(1);
  // 접고 다시 열어도 과거 선택과 정답 표시를 유지한다.
  await userEvent.click(screen.getByRole('button', { name: '해설 접기' }));
  expect(screen.queryByText(/\(내 선택\)/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '해설 보기' }));
  expect(screen.getByText(`${item.choices[selectedIndex]} (내 선택)`)).toBeTruthy();
  expect(screen.getByText('보기 다 (정답)')).toBeTruthy();
  client.clear();
});
