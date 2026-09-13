import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ApiError,
  NetworkError,
  RequestTimeoutError,
  request,
  setAccessToken,
  setReauthorizer,
} from './client.ts';

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test.local');
  vi.useFakeTimers();
});

afterEach(() => {
  setAccessToken(null);
  setReauthorizer(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('30초 무응답을 중단하고 쓰기를 자동 재전송하지 않는다', async () => {
  let signal: AbortSignal | undefined;
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const result = request('/v1/sessions/MOCK/answer', { method: 'POST' }).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBeInstanceOf(RequestTimeoutError);
  expect(signal?.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('헤더 도착 후 본문이 멈춰도 제한시간을 적용한다', async () => {
  const response = new Response();
  vi.spyOn(response, 'json').mockReturnValue(new Promise(() => {}));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const result = request('/v1/exams').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toBeInstanceOf(RequestTimeoutError);
});

it('성공 응답 후 타이머를 해제한다', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true })));
  expect(await request('/v1/exams')).toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});

it('네트워크 실패와 503 메시지의 종류를 보존한다', async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error('MOCK offline'))
    .mockResolvedValueOnce(
      Response.json(
        {
          code: 'IDENTITY_PROVIDER_UNAVAILABLE',
          message: '인증 서버가 일시적으로 응답하지 않아요.',
          retryable: true,
          requestId: 'MOCK-request',
        },
        { status: 503 },
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  await expect(request('/v1/exams')).rejects.toBeInstanceOf(NetworkError);
  await expect(request('/v1/exams')).rejects.toMatchObject({
    status: 503,
    message: '인증 서버가 일시적으로 응답하지 않아요.',
    retryable: true,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('401 재인증은 한 번만 하고 갱신된 토큰으로 재요청한다', async () => {
  const unauthorized = () =>
    Response.json(
      { code: 'AUTH_REQUIRED', message: '인증이 필요해요.', retryable: false, requestId: 'MOCK' },
      { status: 401 },
    );
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(unauthorized()));
  vi.stubGlobal('fetch', fetchMock);
  const renew = vi.fn(async () => {
    setAccessToken('MOCK-renewed-token');
    return 'MOCK-renewed-token';
  });
  setReauthorizer(renew);
  await expect(request('/v1/exams')).rejects.toBeInstanceOf(ApiError);
  expect(renew).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1].headers.authorization).toBe('Bearer MOCK-renewed-token');
  expect(vi.getTimerCount()).toBe(0);
});
