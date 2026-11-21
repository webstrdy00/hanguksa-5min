import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ApiError,
  NetworkError,
  RequestTimeoutError,
  ResponseFormatError,
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

it.each([200, 503])('HTTP %i 헤더 도착 후 본문이 멈춰도 제한시간을 적용한다', async (status) => {
  const response = new Response(null, { status });
  vi.spyOn(response, 'json').mockReturnValue(new Promise(() => {}));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const result = request('/v1/exams').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toBeInstanceOf(RequestTimeoutError);
  expect(vi.getTimerCount()).toBe(0);
});

it('제한시간의 abort로 본문 읽기가 실패해도 응답 형식 오류로 바꾸지 않는다', async () => {
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const response = new Response();
    vi.spyOn(response, 'json').mockImplementation(
      () =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('MOCK private body error')),
          );
        }),
    );
    return Promise.resolve(response);
  });
  vi.stubGlobal('fetch', fetchMock);
  const result = request('/v1/exams').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toBeInstanceOf(RequestTimeoutError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('성공 응답 후 타이머를 해제한다', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true })));
  expect(await request('/v1/exams')).toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});

it('성공 응답의 잘못된 JSON을 고정된 응답 형식 오류로 바꾼다', async () => {
  const rawBody = '{"MOCK-private-body":"MOCK-private-token"';
  const response = new Response(rawBody);
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  const error = await request('/v1/exams').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ResponseFormatError);
  expect(error).not.toBeInstanceOf(NetworkError);
  expect(error).not.toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    name: 'ResponseFormatError',
    message: '서버 응답을 확인할 수 없어요. 잠시 후 다시 시도해주세요.',
  });
  expect(error).not.toHaveProperty('cause');
  expect(error).not.toHaveProperty('body');
  expect(error).not.toHaveProperty('response');
  expect(error).not.toHaveProperty('url');
  expect(String(error)).not.toContain('MOCK-private');
  expect(JSON.stringify(error)).not.toContain('MOCK-private');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([200, 503])(
  'HTTP %i 본문 읽기 예외와 원본 응답을 오류에 보관하지 않는다',
  async (status) => {
    const rawBody = 'MOCK-private-body';
    const rawUrl = 'https://test.local/?token=MOCK-private-token';
    const response = new Response(rawBody, { status });
    const rawError = Object.assign(new Error(`${rawBody} ${rawUrl}`), { cause: response });
    vi.spyOn(response, 'json').mockRejectedValue(rawError);
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const error = await request('/v1/exams').catch((e: unknown) => e);
    if (status === 200) {
      expect(error).toBeInstanceOf(ResponseFormatError);
      expect(error).toHaveProperty(
        'message',
        '서버 응답을 확인할 수 없어요. 잠시 후 다시 시도해주세요.',
      );
    } else {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status,
        code: 'INVALID_ERROR_RESPONSE',
        message: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.',
        retryable: true,
        requestId: '',
      });
    }
    expect(error).not.toBe(rawError);
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('body');
    expect(error).not.toHaveProperty('response');
    expect(error).not.toHaveProperty('url');
    expect(error).not.toHaveProperty('details');
    expect(String(error)).not.toContain('MOCK-private');
    expect(JSON.stringify(error)).not.toContain('MOCK-private');
    expect(error).toHaveProperty('stack', expect.not.stringContaining('MOCK-private'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('204 응답은 본문을 읽지 않고 undefined를 반환한다', async () => {
  const response = new Response(null, { status: 204 });
  const json = vi.spyOn(response, 'json');
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  await expect(request<void>('/v1/profile', { method: 'DELETE' })).resolves.toBeUndefined();
  expect(json).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([400, 401, 429, 500, 503])(
  'JSON이 아닌 HTTP %i 오류는 상태와 헤더 요청 ID만 보존한다',
  async (status) => {
    const response = new Response('<html>MOCK-private-body MOCK-private-token</html>', {
      status,
      headers: { 'x-request-id': 'MOCK-header-request' },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const renew = vi.fn();
    setReauthorizer(renew);
    const error = await request('/v1/auth/bootstrap', { authorized: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status,
      code: 'INVALID_ERROR_RESPONSE',
      message: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.',
      retryable: status >= 500,
      requestId: 'MOCK-header-request',
    });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('body');
    expect(error).not.toHaveProperty('response');
    expect(String(error)).not.toContain('MOCK-private');
    expect(JSON.stringify(error)).not.toContain('MOCK-private');
    expect(renew).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  { label: 'null', body: null },
  { label: '배열', body: [{ code: 'MOCK_CODE', message: 'MOCK-private-body' }] },
  { label: '문자열', body: 'MOCK-private-body' },
  { label: '숫자', body: 42 },
  { label: '불리언', body: false },
  { label: '빈 객체', body: {} },
  { label: 'code 누락', body: { message: 'MOCK-private-body' } },
  { label: 'message 누락', body: { code: 'MOCK_CODE' } },
  { label: '문자열이 아닌 code', body: { code: 42, message: 'MOCK-private-body' } },
  { label: '문자열이 아닌 message', body: { code: 'MOCK_CODE', message: {} } },
])('오류 envelope가 $label이면 안전한 서버 오류로 처리한다', async ({ body }) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(body, { status: 502, headers: { 'x-request-id': 'MOCK-header-request' } }),
      ),
  );
  const error = await request('/v1/exams').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    status: 502,
    code: 'INVALID_ERROR_RESPONSE',
    message: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.',
    retryable: true,
    requestId: 'MOCK-header-request',
  });
  expect(String(error)).not.toContain('MOCK-private');
  expect(JSON.stringify(error)).not.toContain('MOCK-private');
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { status: 400, retryable: 'true', requestId: 42 },
  { status: 503, retryable: 'false', requestId: false },
  { status: 400, retryable: 1, requestId: [] },
  { status: 503, retryable: 0, requestId: {} },
  { status: 400, retryable: null, requestId: null },
  { status: 503, retryable: [], requestId: 42 },
  { status: 400, retryable: {}, requestId: true },
  { status: 503, retryable: undefined, requestId: undefined },
])(
  'HTTP $status의 잘못된 retryable/requestId 타입은 상태와 헤더의 기본값을 사용한다',
  async ({ status, retryable, requestId }) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { code: 'MOCK_CODE', message: '서버에서 안내한 오류예요.', retryable, requestId },
            { status, headers: { 'x-request-id': 'MOCK-header-request' } },
          ),
        ),
    );
    await expect(request('/v1/exams')).rejects.toMatchObject({
      status,
      code: 'MOCK_CODE',
      message: '서버에서 안내한 오류예요.',
      retryable: status >= 500,
      requestId: 'MOCK-header-request',
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  { status: 400, retryable: true, requestId: 'MOCK-body-request' },
  { status: 503, retryable: false, requestId: '' },
])('HTTP $status의 유효한 오류 필드는 상태/헤더 기본값보다 우선한다', async (envelope) => {
  const { status, retryable, requestId } = envelope;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          code: 'MOCK_CODE',
          message: '서버에서 안내한 오류예요.',
          retryable,
          requestId,
          details: { token: 'MOCK-private-token' },
        },
        { status, headers: { 'x-request-id': 'MOCK-header-request' } },
      ),
    ),
  );
  const error = await request('/v1/exams').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    status,
    code: 'MOCK_CODE',
    message: '서버에서 안내한 오류예요.',
    retryable,
    requestId,
  });
  expect(error).not.toHaveProperty('details');
  expect(JSON.stringify(error)).not.toContain('MOCK-private-token');
});

it.each([
  {
    retryable: false,
    requestId: 42,
    expectedRetryable: false,
    expectedRequestId: 'MOCK-header-request',
  },
  {
    retryable: 'false',
    requestId: 'MOCK-body-request',
    expectedRetryable: true,
    expectedRequestId: 'MOCK-body-request',
  },
])('retryable과 requestId의 타입은 독립적으로 검사한다', async (fields) => {
  const { retryable, requestId, expectedRetryable, expectedRequestId } = fields;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: 'MOCK_CODE', message: '서버에서 안내한 오류예요.', retryable, requestId },
          { status: 503, headers: { 'x-request-id': 'MOCK-header-request' } },
        ),
      ),
  );
  await expect(request('/v1/exams')).rejects.toMatchObject({
    status: 503,
    code: 'MOCK_CODE',
    message: '서버에서 안내한 오류예요.',
    retryable: expectedRetryable,
    requestId: expectedRequestId,
  });
});

it('오류 응답과 헤더에 문자열 요청 ID가 없으면 빈 문자열을 사용한다', async () => {
  const response = Response.json(
    { code: 'MOCK_CODE', message: '서버에서 안내한 오류예요.' },
    {
      status: 400,
    },
  );
  vi.spyOn(response.headers, 'get').mockReturnValue(42 as unknown as string);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(request('/v1/exams')).rejects.toMatchObject({
    status: 400,
    requestId: '',
    retryable: false,
  });
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

it.each([true, false])(
  '401 재인증은 오류 envelope 유효 여부(%s)와 무관하게 한 번만 수행한다',
  async (validEnvelope) => {
    const unauthorized = () =>
      validEnvelope
        ? Response.json(
            {
              code: 'AUTH_REQUIRED',
              message: '인증이 필요해요.',
              retryable: false,
              requestId: 'MOCK',
            },
            { status: 401 },
          )
        : new Response('<html>MOCK-private-body</html>', { status: 401 });
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
  },
);
