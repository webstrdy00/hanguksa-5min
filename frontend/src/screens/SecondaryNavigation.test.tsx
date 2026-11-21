import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ProgressScreen } from './ProgressScreen.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { WrongNotesScreen } from './WrongNotesScreen.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ['오답노트', WrongNotesScreen],
  ['학습현황', ProgressScreen],
  ['설정', SettingsScreen],
] as const)('%s는 제목을 유지하고 별도 뒤로가기 없이 이전 경로로 돌아간다', async (title, Page) => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 503 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/', element: <h1>홈</h1> },
      { path: '/detail', element: <Page /> },
    ],
    { initialEntries: ['/', '/detail'] },
  );
  try {
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { name: title, level: 1 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /뒤로\s*가기|←/ })).toBeNull();
    await act(() => router.navigate(-1));
    expect(screen.getByRole('heading', { name: '홈' })).toBeTruthy();
  } finally {
    router.dispose();
    client.clear();
  }
});
