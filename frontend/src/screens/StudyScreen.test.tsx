import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
        <Routes>
          <Route path="/" element={<StudyScreen />} />
          <Route path="/result" element={<h1>테스트 결과 화면</h1>} />
        </Routes>
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
  it('미답 문항이 하나 남아 있으면 결과가 아니라 다음 문제로 안내한다', async () => {
    mockFetch(() => ({
      ...session,
      items: session.items.map((item, index) =>
        index === 4 ? item : { ...item, answered: true, selectedIndex: 1, correctIndex: 0 },
      ),
    }));
    renderScreen();
    await screen.findByText('문항 0 입니다');
    expect(screen.queryByRole('button', { name: '결과 보기' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '다음 문제' }));
    expect(await screen.findByText('문항 4 입니다')).toBeTruthy();
  });

  it('마지막 답안 저장 후 세션 재조회가 지연돼도 결과로 이동한다', async () => {
    let answered = false;
    vi.stubGlobal('fetch', (input: string) => {
      if (String(input).includes('/answer')) {
        answered = true;
        return Promise.resolve(Response.json({ ...answerResponse, answeredCount: 5 }));
      }
      // MOCK: 답안 저장은 성공했지만 세션 재조회 응답은 아직 도착하지 않았다.
      if (answered) return new Promise<Response>(() => {});
      return Promise.resolve(
        Response.json({
          ...session,
          items: session.items.map((item, index) =>
            index === 0 ? item : { ...item, answered: true, selectedIndex: 1, correctIndex: 0 },
          ),
        }),
      );
    });
    renderScreen();
    await screen.findByText('문항 0 입니다');
    await userEvent.click(screen.getAllByRole('radio')[1]!);
    await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
    await screen.findByText('정답 근거 해설입니다');
    await userEvent.click(screen.getByRole('button', { name: '결과 보기' }));
    expect(await screen.findByRole('heading', { name: '테스트 결과 화면' })).toBeTruthy();
  });

  it('채점이 지연되는 동안 연타해도 답안을 한 번만 전송한다', async () => {
    const requests: string[] = [];
    let respond: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', (input: string) => {
      if (!String(input).includes('/answer')) return Promise.resolve(Response.json(session));
      requests.push(String(input));
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    });
    renderScreen();
    await screen.findByText('문항 0 입니다');
    await userEvent.click(screen.getAllByRole('radio')[1]!);
    await userEvent.dblClick(screen.getByRole('button', { name: '답 제출하기' }));
    expect(requests).toHaveLength(1);
    expect(screen.getByRole('button', { name: '채점하고 있어요' }).hasAttribute('disabled')).toBe(
      true,
    );
    await userEvent.click(screen.getAllByRole('radio')[2]!);
    expect(screen.getAllByRole<HTMLInputElement>('radio')[1]!.checked).toBe(true);
    respond!(Response.json(answerResponse));
    await screen.findByText('정답 근거 해설입니다');
  });

  it('답안 전송 실패 후 선택을 보존하고 같은 답으로 재시도한다', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      if (!String(input).includes('/answer')) return Promise.resolve(Response.json(session));
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return Promise.reject(new Error('MOCK offline'));
      return Promise.resolve(Response.json(answerResponse));
    });
    renderScreen();
    await screen.findByText('문항 0 입니다');
    await userEvent.click(screen.getAllByRole('radio')[2]!);
    await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
    await screen.findByRole('alert');
    expect(screen.getAllByRole<HTMLInputElement>('radio')[2]!.checked).toBe(true);
    expect(bodies).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
    await screen.findByText('정답 근거 해설입니다');
    expect(bodies).toEqual([
      { questionRevisionId: 'rev-0', selectedIndex: 2 },
      { questionRevisionId: 'rev-0', selectedIndex: 2 },
    ]);
  });

  it('다섯 문항 모두 제출 전에 선택 표시를 갱신하고 다음 문항에서 초기화한다', async () => {
    const state = structuredClone(session);
    mockFetch((url, init) => {
      if (!url.includes('/answer')) return state;
      const body = JSON.parse(String(init?.body)) as {
        questionRevisionId: string;
        selectedIndex: number;
      };
      const item = state.items.find(
        (entry) => entry.questionRevisionId === body.questionRevisionId,
      )!;
      Object.assign(item, {
        answered: true,
        selectedIndex: body.selectedIndex,
        correctIndex: 0,
        isCorrect: false,
        explanation: answerResponse.explanation,
      });
      return answerResponse;
    });
    renderScreen();

    for (let index = 0; index < 5; index++) {
      await screen.findByText(`문항 ${index} 입니다`);
      const choices = screen.getAllByRole<HTMLInputElement>('radio');
      expect(choices.every((choice) => !choice.checked)).toBe(true);
      expect(screen.getByRole('button', { name: '답 제출하기' }).hasAttribute('disabled')).toBe(
        true,
      );
      await userEvent.click(choices[1]!);
      expect(choices[1]!.checked).toBe(true);
      await userEvent.click(choices[2]!);
      expect(choices[1]!.checked).toBe(false);
      expect(choices[2]!.checked).toBe(true);
      await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
      await screen.findByText('내 선택');
      expect(choices[2]!.checked).toBe(true);
      if (index < 4) {
        await userEvent.click(screen.getByRole('button', { name: /다음 문제|결과 보기/ }));
      }
    }
  });

  it('재진입한 해설에서는 서버에 저장된 선택을 표시한다', async () => {
    mockFetch(() => ({
      ...session,
      items: [
        makeItem(0, {
          answered: true,
          selectedIndex: 3,
          correctIndex: 0,
          isCorrect: false,
          explanation: answerResponse.explanation,
        }),
        ...session.items.slice(1),
      ],
    }));
    renderScreen();
    await screen.findByText('내 선택');
    expect(screen.getAllByRole<HTMLInputElement>('radio')[3]!.checked).toBe(true);
  });

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
