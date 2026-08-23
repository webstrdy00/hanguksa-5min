import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerResponse, SessionResponse } from '../api/types.ts';
import { StudyScreen } from './StudyScreen.tsx';

/**
 * 문제/해설 화면 테스트.
 *
 * 검증 초점:
 * - 풀기 전에는 정답과 해설이 화면에 없다.
 * - 답 제출 중에는 버튼이 잠겨 중복 제출이 되지 않는다 (02 UX §5).
 * - 정답/오답을 색이 아니라 텍스트로도 구분한다 (공통 05 §3).
 * - void 문항은 풀지 않고 넘어가며 사용자를 탓하지 않는다 (09 §2).
 */

function makeItem(index: number, overrides: Partial<SessionResponse['items'][number]> = {}) {
  return {
    slotIndex: index,
    slotSource: 'new',
    questionRevisionId: `rev-${index}`,
    era: 'goryeo',
    topic: 'politics',
    difficulty: 2,
    prompt: `문항 ${index} 입니다`,
    choices: ['보기 1', '보기 2', '보기 3', '보기 4', '보기 5'],
    voided: false,
    answered: false,
    ...overrides,
  };
}

const session: SessionResponse = {
  session: {
    id: 'session-1',
    studyDate: '2026-08-23',
    completedAt: null,
    score: null,
    createdAt: '2026-08-23T00:00:00.000Z',
  },
  items: [makeItem(0), makeItem(1), makeItem(2), makeItem(3), makeItem(4)],
};

const answerResponse: AnswerResponse = {
  isCorrect: false,
  correctIndex: 0,
  explanation: '정답 근거 해설입니다',
  wrongAnswerNotes: null,
  memoryKeyword: '고려 제도',
  answeredCount: 1,
  validCount: 5,
  replayed: false,
};

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StudyScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const body = handler(String(input), init);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test.local');
});

afterEach(() => {
  // globals: false 라서 자동 cleanup 이 등록되지 않는다. 직접 정리해야 이전 렌더가 남지 않는다.
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('StudyScreen', () => {
  it('풀기 전에는 정답과 해설을 보여주지 않는다', async () => {
    mockFetch(() => session);
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText('문항 0 입니다')).toBeTruthy();
    });

    expect(screen.queryByText('정답 근거 해설입니다')).toBeNull();
    expect(screen.queryByText('정답')).toBeNull();
  });

  it('선택 전에는 제출 버튼이 잠겨 있다', async () => {
    mockFetch(() => session);
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText('문항 0 입니다')).toBeTruthy();
    });

    const submit = screen.getByRole('button', { name: '답 제출하기' });
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('답을 고르면 제출할 수 있고 해설이 나온다', async () => {
    mockFetch((url) => (url.includes('/answer') ? answerResponse : session));
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText('문항 0 입니다')).toBeTruthy();
    });

    const choices = screen.getAllByRole('radio');
    await userEvent.click(choices[1]!);

    const submit = screen.getByRole('button', { name: '답 제출하기' });
    expect(submit.hasAttribute('disabled')).toBe(false);
    await userEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText('정답 근거 해설입니다')).toBeTruthy();
    });

    // 색이 아니라 텍스트로도 결과를 알 수 있어야 한다.
    expect(screen.getByText('틀렸어요')).toBeTruthy();
    expect(screen.getByText('정답')).toBeTruthy();
    expect(screen.getByText('내 선택')).toBeTruthy();
  });

  it('제출 후에는 선택지를 바꿀 수 없다', async () => {
    mockFetch((url) => (url.includes('/answer') ? answerResponse : session));
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText('문항 0 입니다')).toBeTruthy();
    });

    await userEvent.click(screen.getAllByRole('radio')[1]!);
    await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));

    await waitFor(() => {
      expect(screen.getByText('정답 근거 해설입니다')).toBeTruthy();
    });

    // 선택지를 감싼 fieldset 이 잠긴다. jsdom 은 fieldset disabled 를 자식 input 속성까지
    // 전파하지 않으므로 fieldset 자체를 확인한다.
    const fieldset = screen.getAllByRole('radio')[0]!.closest('fieldset');
    expect(fieldset?.hasAttribute('disabled')).toBe(true);
  });

  it('void 된 문항은 풀지 않고 넘어가며 사용자를 탓하지 않는다', async () => {
    const withVoided: SessionResponse = {
      ...session,
      items: [makeItem(0, { voided: true }), ...session.items.slice(1)],
    };
    mockFetch(() => withVoided);
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText('확인 중인 문항')).toBeTruthy();
    });

    expect(screen.getByText(/채점에서 제외했어요/)).toBeTruthy();
    expect(screen.getByText(/연속 학습일은/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '다음 문제' })).toBeTruthy();
  });

  it('네트워크 오류에는 재시도 경로를 준다', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    renderScreen();

    // 네트워크 오류는 자동 재시도 대상이라 몇 번 더 시도한 뒤에 화면에 나온다.
    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeTruthy();
      },
      { timeout: 10_000 },
    );

    expect(screen.getByRole('button', { name: /다시 시도|새로고침/ })).toBeTruthy();
  });

  it('오류 제보 버튼이 있고 고른 답을 보내지 않는다고 알린다', async () => {
    mockFetch(() => session);
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText('문항 0 입니다')).toBeTruthy();
    });

    await userEvent.click(screen.getByRole('button', { name: '오류 제보' }));

    expect(screen.getByRole('dialog', { name: '문항 오류 제보' })).toBeTruthy();
    expect(screen.getByText('고른 답은 전송되지 않아요.')).toBeTruthy();
  });
});
