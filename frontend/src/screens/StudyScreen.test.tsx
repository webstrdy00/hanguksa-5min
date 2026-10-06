import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/hooks.ts';
import type { AnswerResponse, SessionResponse } from '../api/types.ts';
import { StudyScreen } from './StudyScreen.tsx';

const { trackImpression, scheduleFirstQuestionReady } = vi.hoisted(() => ({
  trackImpression: vi.fn(),
  scheduleFirstQuestionReady:
    vi.fn<typeof import('../analytics/study-performance.ts').scheduleFirstQuestionReady>(),
}));
vi.mock('../analytics/events.ts', () => ({
  trackScreen: vi.fn(),
  trackClick: vi.fn(),
  trackOperational: vi.fn(),
  trackImpression,
}));
vi.mock('../analytics/study-performance.ts', () => ({ scheduleFirstQuestionReady }));

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

function renderScreen(
  strict = false,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  const content = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<StudyScreen />} />
          <Route path="/result" element={<h1>테스트 결과 화면</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  return render(strict ? <StrictMode>{content}</StrictMode> : content);
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

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((resolveResponse, rejectResponse) => {
    resolve = resolveResponse;
    reject = rejectResponse;
  });
  return { promise, resolve, reject };
}

function answerStateError(status: 409 | 422) {
  return Response.json(
    {
      code: status === 409 ? 'ANSWER_CONFLICT' : 'QUESTION_VOIDED',
      message: status === 409 ? '이미 저장된 답이 있어요.' : '확인 중인 문항이에요.',
      retryable: false,
      requestId: 'request-1',
    },
    { status },
  );
}

function authoritativeSession(status: 409 | 422): SessionResponse {
  return {
    ...session,
    items: [
      makeItem(
        0,
        status === 409
          ? {
              answered: true,
              selectedIndex: 3,
              correctIndex: 0,
              isCorrect: false,
              explanation: '서버에 저장된 해설입니다',
            }
          : { voided: true },
      ),
      ...session.items.slice(1),
    ],
  };
}

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test.local');
  trackImpression.mockClear();
  scheduleFirstQuestionReady.mockReset();
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

  it.each([
    { status: 409, strict: false },
    { status: 422, strict: false },
    { status: 409, strict: true },
    { status: 422, strict: true },
  ] as const)(
    '$status 재조회가 느려도 연타·새로고침으로 오래된 답을 다시 보내지 않는다 (StrictMode=$strict)',
    async ({ status, strict }) => {
      const reconciliation = deferredResponse();
      let state = authoritativeSession(status);
      let sessionRequests = 0;
      const bodies: Array<{ questionRevisionId: string; selectedIndex: number }> = [];
      vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
        if (String(input).includes('/answer')) {
          const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
          bodies.push(body);
          if (bodies.length === 1) return Promise.resolve(answerStateError(status));
          state = {
            ...state,
            items: state.items.map((item) =>
              item.questionRevisionId === body.questionRevisionId
                ? {
                    ...item,
                    answered: true,
                    selectedIndex: body.selectedIndex,
                    correctIndex: answerResponse.correctIndex,
                    isCorrect: answerResponse.isCorrect,
                    explanation: answerResponse.explanation,
                  }
                : item,
            ),
          };
          return Promise.resolve(Response.json(answerResponse));
        }
        sessionRequests++;
        if (sessionRequests === 1) return Promise.resolve(Response.json(session));
        if (sessionRequests === 2) return reconciliation.promise;
        return Promise.resolve(Response.json(state));
      });
      renderScreen(strict);
      await screen.findByText('문항 0 입니다');
      await userEvent.click(screen.getAllByRole('radio')[2]!);
      await userEvent.dblClick(screen.getByRole('button', { name: '답 제출하기' }));
      await screen.findByRole('alert');
      const pending = screen.getByRole('button', { name: '오늘의 문제를 준비하고 있어요' });
      expect(pending.hasAttribute('disabled')).toBe(true);
      expect(pending.getAttribute('aria-busy')).toBe('true');
      expect(screen.getAllByRole('radio')[0]!.closest('fieldset')?.hasAttribute('disabled')).toBe(
        true,
      );
      await userEvent.click(screen.getAllByRole('radio')[1]!);
      expect(screen.getAllByRole<HTMLInputElement>('radio')[2]!.checked).toBe(true);
      await userEvent.dblClick(pending);
      await userEvent.dblClick(screen.getByRole('button', { name: '새로고침' }));
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(
        screen
          .getByRole('button', { name: '오늘의 문제를 준비하고 있어요' })
          .hasAttribute('disabled'),
      ).toBe(true);
      expect(sessionRequests).toBe(2);
      expect(bodies).toEqual([{ questionRevisionId: 'rev-0', selectedIndex: 2 }]);

      reconciliation.resolve(Response.json(state));
      if (status === 409) {
        await screen.findByText('서버에 저장된 해설입니다');
        expect(screen.getAllByRole<HTMLInputElement>('radio')[3]!.checked).toBe(true);
        expect(screen.getAllByRole<HTMLInputElement>('radio')[2]!.checked).toBe(false);
        expect(screen.getByText('틀렸어요')).toBeTruthy();
      } else {
        await screen.findByText('확인 중인 문항');
        expect(screen.queryByText('문항 0 입니다')).toBeNull();
        expect(screen.queryAllByRole('radio')).toHaveLength(0);
        expect(screen.queryByText('정답 근거 해설입니다')).toBeNull();
      }
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(sessionRequests).toBe(2);
      await userEvent.click(screen.getByRole('button', { name: '다음 문제' }));
      await screen.findByText('문항 1 입니다');
      expect(
        screen.getAllByRole<HTMLInputElement>('radio').every((choice) => !choice.checked),
      ).toBe(true);
      expect(screen.getByRole('button', { name: '답 제출하기' }).hasAttribute('disabled')).toBe(
        true,
      );
      await userEvent.click(screen.getAllByRole('radio')[1]!);
      await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
      await screen.findByText('정답 근거 해설입니다');
      expect(bodies).toEqual([
        { questionRevisionId: 'rev-0', selectedIndex: 2 },
        { questionRevisionId: 'rev-1', selectedIndex: 1 },
      ]);
    },
  );

  it.each([409, 422] as const)(
    '%i 즉시 재조회에서도 서버 답안·무효 상태를 반영한다',
    async (status) => {
      let sessionRequests = 0;
      let answerRequests = 0;
      vi.stubGlobal('fetch', (input: string) => {
        if (String(input).includes('/answer')) {
          answerRequests++;
          return Promise.resolve(answerStateError(status));
        }
        sessionRequests++;
        return Promise.resolve(
          Response.json(sessionRequests === 1 ? session : authoritativeSession(status)),
        );
      });
      renderScreen();
      await screen.findByText('문항 0 입니다');
      await userEvent.click(screen.getAllByRole('radio')[2]!);
      await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
      await screen.findByText(status === 409 ? '서버에 저장된 해설입니다' : '확인 중인 문항');
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(sessionRequests).toBe(2);
      expect(answerRequests).toBe(1);
      await userEvent.click(screen.getByRole('button', { name: '다음 문제' }));
      expect(await screen.findByText('문항 1 입니다')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it.each([409, 422] as const)(
    '%i 이전에 시작된 조회가 오래된 미답 상태를 반환해도 새 재조회가 끝날 때까지 잠금을 유지한다',
    async (status) => {
      const previousRequest = deferredResponse();
      const reconciliation = deferredResponse();
      let sessionRequests = 0;
      let answerRequests = 0;
      vi.stubGlobal('fetch', (input: string) => {
        if (String(input).includes('/answer')) {
          answerRequests++;
          return Promise.resolve(answerStateError(status));
        }
        sessionRequests++;
        return sessionRequests === 1 ? previousRequest.promise : reconciliation.promise;
      });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      client.setQueryData(queryKeys.session, session);
      renderScreen(false, client);
      await screen.findByText('문항 0 입니다');
      await waitFor(() => expect(sessionRequests).toBe(1));
      await userEvent.click(screen.getAllByRole('radio')[2]!);
      await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
      await screen.findByRole('alert');
      expect(sessionRequests).toBe(2);
      await act(async () => {
        previousRequest.resolve(Response.json(session));
      });
      expect(
        screen
          .getByRole('button', { name: '오늘의 문제를 준비하고 있어요' })
          .hasAttribute('disabled'),
      ).toBe(true);
      await userEvent.dblClick(screen.getByRole('button', { name: '새로고침' }));
      expect(sessionRequests).toBe(2);
      expect(answerRequests).toBe(1);
      expect(screen.getByRole('alert')).toBeTruthy();
      reconciliation.resolve(Response.json(authoritativeSession(status)));
      await screen.findByText(status === 409 ? '서버에 저장된 해설입니다' : '확인 중인 문항');
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(sessionRequests).toBe(2);
      expect(answerRequests).toBe(1);
    },
  );

  it.each([409, 422] as const)(
    '%i 재조회가 실패해도 다시 시도가 실제 조회를 수행하고 잠금을 해제한다',
    async (status) => {
      const reconciliation = deferredResponse();
      const recovery = deferredResponse();
      let sessionRequests = 0;
      let answerRequests = 0;
      vi.stubGlobal('fetch', (input: string) => {
        if (String(input).includes('/answer')) {
          answerRequests++;
          return Promise.resolve(answerStateError(status));
        }
        sessionRequests++;
        if (sessionRequests === 1) return Promise.resolve(Response.json(session));
        if (sessionRequests === 2) return reconciliation.promise;
        if (sessionRequests <= 4) return Promise.reject(new Error('MOCK reconciliation offline'));
        return recovery.promise;
      });
      const client = new QueryClient({
        defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } },
      });
      renderScreen(false, client);
      await screen.findByText('문항 0 입니다');
      await userEvent.click(screen.getAllByRole('radio')[2]!);
      await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
      await screen.findByRole('alert');
      await userEvent.click(screen.getByRole('button', { name: '새로고침' }));
      reconciliation.reject(new Error('MOCK reconciliation offline'));
      await screen.findByText(/네트워크에 연결할 수 없어요/);
      expect(sessionRequests).toBe(4);
      expect(screen.queryByText('문항 0 입니다')).toBeNull();
      expect(screen.queryByRole('button', { name: '답 제출하기' })).toBeNull();
      await userEvent.dblClick(screen.getByRole('button', { name: '다시 시도' }));
      expect(sessionRequests).toBe(5);
      expect(answerRequests).toBe(1);
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.queryByText('문항 0 입니다')).toBeNull();

      recovery.resolve(Response.json(authoritativeSession(status)));
      await screen.findByText(status === 409 ? '서버에 저장된 해설입니다' : '확인 중인 문항');
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(sessionRequests).toBe(5);
      expect(answerRequests).toBe(1);
      await userEvent.click(screen.getByRole('button', { name: '다음 문제' }));
      expect(await screen.findByText('문항 1 입니다')).toBeTruthy();
      expect(screen.getAllByRole('radio')[0]!.closest('fieldset')?.hasAttribute('disabled')).toBe(
        false,
      );
      await userEvent.click(screen.getAllByRole('radio')[1]!);
      expect(screen.getByRole('button', { name: '답 제출하기' }).hasAttribute('disabled')).toBe(
        false,
      );
    },
  );

  it.each([409, 422] as const)(
    '%i 이후 재조회가 같은 미답 상태를 반환해도 조회가 끝난 뒤에만 새 선택으로 제출할 수 있다',
    async (status) => {
      const reconciliation = deferredResponse();
      const bodies: unknown[] = [];
      let sessionRequests = 0;
      vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
        if (String(input).includes('/answer')) {
          bodies.push(JSON.parse(String(init?.body)));
          return Promise.resolve(
            bodies.length === 1 ? answerStateError(status) : Response.json(answerResponse),
          );
        }
        sessionRequests++;
        if (sessionRequests === 2) return reconciliation.promise;
        return Promise.resolve(Response.json(session));
      });
      renderScreen();
      await screen.findByText('문항 0 입니다');
      await userEvent.click(screen.getAllByRole('radio')[2]!);
      await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
      await screen.findByRole('alert');
      expect(bodies).toHaveLength(1);
      reconciliation.resolve(Response.json(session));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(
        screen.getAllByRole<HTMLInputElement>('radio').every((choice) => !choice.checked),
      ).toBe(true);
      expect(screen.getAllByRole('radio')[0]!.closest('fieldset')?.hasAttribute('disabled')).toBe(
        false,
      );
      expect(screen.getByRole('button', { name: '답 제출하기' }).hasAttribute('disabled')).toBe(
        true,
      );
      await userEvent.click(screen.getAllByRole('radio')[1]!);
      await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
      await screen.findByText('정답 근거 해설입니다');
      expect(bodies).toEqual([
        { questionRevisionId: 'rev-0', selectedIndex: 2 },
        { questionRevisionId: 'rev-0', selectedIndex: 1 },
      ]);
    },
  );

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

describe('StudyScreen first usable question impression', () => {
  let frames: Map<number, FrameRequestCallback>;

  function advanceFrame() {
    act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    });
  }

  function cachedClient(data: SessionResponse = session) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnMount: false },
        mutations: { retry: false },
      },
    });
    client.setQueryData(queryKeys.session, data);
    return client;
  }

  beforeEach(async () => {
    // Reset only the actual timing module's lifetime, while the screen keeps its React contexts.
    vi.resetModules();
    const timing = await vi.importActual<typeof import('../analytics/study-performance.ts')>(
      '../analytics/study-performance.ts',
    );
    scheduleFirstQuestionReady.mockImplementation(timing.scheduleFirstQuestionReady);
    frames = new Map();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(performance, 'now').mockReturnValue(500);
  });

  it('does not emit while the query is loading', () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    renderScreen();
    expect(screen.getByText('오늘의 문제를 준비하고 있어요')).toBeTruthy();
    advanceFrame();
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();
  });

  it('cancels pending timing when the query errors even if cached questions remain', async () => {
    const client = cachedClient();
    renderScreen(false, client);
    expect(screen.getByText('문항 0 입니다')).toBeTruthy();
    advanceFrame();
    await act(async () => {
      client
        .getQueryCache()
        .find({ queryKey: queryKeys.session })!
        .setState({
          status: 'error',
          error: new Error('MOCK private error detail'),
        });
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('문항 0 입니다')).toBeNull();
    advanceFrame();
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();
  });

  const unavailable: Array<{ name: string; data: SessionResponse; button: string }> = [
    {
      name: 'answered-only',
      data: { ...session, items: session.items.map((item) => ({ ...item, answered: true })) },
      button: '결과 보기',
    },
    {
      name: 'explanation with later unanswered questions',
      data: { ...session, items: [makeItem(0, { answered: true }), ...session.items.slice(1)] },
      button: '다음 문제',
    },
    {
      name: 'void with later unanswered questions',
      data: { ...session, items: [makeItem(0, { voided: true }), ...session.items.slice(1)] },
      button: '다음 문제',
    },
    {
      name: 'completed-only',
      data: {
        ...session,
        session: { ...session.session, completedAt: '2026-08-23T00:05:00.000Z' },
        items: session.items.map((item) => ({ ...item, answered: true })),
      },
      button: '결과 보기',
    },
    { name: 'empty', data: { ...session, items: [] }, button: '홈으로' },
    {
      name: 'blank prompt',
      data: { ...session, items: [makeItem(0, { prompt: ' ' })] },
      button: '답 제출하기',
    },
    {
      name: 'missing choices',
      data: { ...session, items: [makeItem(0, { choices: [] })] },
      button: '답 제출하기',
    },
    {
      name: 'no choice of answers',
      data: { ...session, items: [makeItem(0, { choices: ['보기 1'] })] },
      button: '답 제출하기',
    },
    {
      name: 'blank choice',
      data: { ...session, items: [makeItem(0, { choices: ['보기 1', ' '] })] },
      button: '답 제출하기',
    },
  ];

  it.each(unavailable)('does not emit for $name', ({ data, button }) => {
    renderScreen(false, cachedClient(data));
    expect(screen.getByRole('button', { name: button })).toBeTruthy();
    advanceFrame();
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();
  });

  it.each(['voided', 'answered'] as const)(
    'waits until leaving the %s question for a usable one',
    async (flag) => {
      renderScreen(
        false,
        cachedClient({
          ...session,
          items: [makeItem(0, { [flag]: true }), ...session.items.slice(1)],
        }),
      );
      advanceFrame();
      advanceFrame();
      expect(trackImpression).not.toHaveBeenCalled();

      vi.mocked(performance.now).mockReturnValue(900);
      await userEvent.click(screen.getByRole('button', { name: '다음 문제' }));
      expect(screen.getByText('문항 1 입니다')).toBeTruthy();
      advanceFrame();
      vi.mocked(performance.now).mockReturnValue(1_500);
      advanceFrame();
      expect(trackImpression).toHaveBeenCalledExactlyOnceWith('first_question_ready', {
        navigation_to_first_question_ready_ms: 1_500,
        study_entry_to_first_question_ready_ms: 1_000,
      });
    },
  );

  it('does not emit during answer submission or a mutation explanation with stale unanswered data', async () => {
    let respond: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', (input: string) => {
      if (!String(input).includes('/answer')) return Promise.resolve(Response.json(session));
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    });
    renderScreen(false, cachedClient());
    await userEvent.click(screen.getAllByRole('radio')[1]!);
    await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
    expect(screen.getByRole('button', { name: '채점하고 있어요' })).toBeTruthy();
    advanceFrame();
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();

    respond!(Response.json(answerResponse));
    await screen.findByText('정답 근거 해설입니다');
    advanceFrame();
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();
  });

  it('does not emit while an answer error is displayed', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('MOCK private answer error')));
    renderScreen(false, cachedClient());
    await userEvent.click(screen.getAllByRole('radio')[1]!);
    await userEvent.click(screen.getByRole('button', { name: '답 제출하기' }));
    await screen.findByRole('alert');
    advanceFrame();
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    'unmounting after %i frames leaves the first usable impression available',
    (count) => {
      const first = renderScreen(true, cachedClient());
      for (let index = 0; index < count; index++) advanceFrame();
      first.unmount();
      advanceFrame();
      advanceFrame();
      expect(trackImpression).not.toHaveBeenCalled();

      vi.mocked(performance.now).mockReturnValue(700);
      renderScreen(true, cachedClient());
      advanceFrame();
      vi.mocked(performance.now).mockReturnValue(1_500);
      advanceFrame();
      expect(trackImpression).toHaveBeenCalledExactlyOnceWith('first_question_ready', {
        navigation_to_first_question_ready_ms: 1_500,
        study_entry_to_first_question_ready_ms: 800,
      });
    },
  );

  it('emits once across StrictMode, selection rerenders and remounts, without sensitive parameters', async () => {
    const first = renderScreen(true, cachedClient());
    expect(screen.getByText('문항 0 입니다')).toBeTruthy();
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();
    vi.mocked(performance.now).mockReturnValue(1_500);
    advanceFrame();
    expect(trackImpression).toHaveBeenCalledExactlyOnceWith('first_question_ready', {
      navigation_to_first_question_ready_ms: 1_500,
      study_entry_to_first_question_ready_ms: 1_000,
    });

    await userEvent.click(screen.getAllByRole('radio')[1]!);
    advanceFrame();
    advanceFrame();
    first.unmount();
    renderScreen(true, cachedClient());
    advanceFrame();
    advanceFrame();
    expect(trackImpression).toHaveBeenCalledTimes(1);
  });
});
