import type { ErrorEnvelope } from './types.ts';

/**
 * 백엔드 API 클라이언트.
 *
 * - 토큰은 **메모리에만** 둔다. 웹 스토리지에 저장하지 않는다 (공통 02 §2, 공통 06 §1).
 * - 401 을 받으면 refresh token 이 아니라 **bootstrap 을 다시** 수행한다 (공통 06 §1).
 * - 오류는 공통 envelope 로 파싱해 화면이 재시도 여부를 판단할 수 있게 한다 (공통 05 §2).
 * - anonKey 를 URL 에 넣지 않는다. bootstrap 본문으로만 보낸다.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = envelope.code;
    this.retryable = envelope.retryable;
    this.requestId = envelope.requestId;
  }
}

/** 네트워크 자체가 실패한 경우. 사용자에게는 연결 문제로 안내한다. */
export class NetworkError extends Error {
  constructor() {
    super('네트워크에 연결할 수 없어요.');
    this.name = 'NetworkError';
  }
}

let accessToken: string | null = null;
/** 401 을 만났을 때 토큰을 다시 받아오는 함수. AuthProvider 가 주입한다. */
let reauthorize: (() => Promise<string | null>) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setReauthorizer(handler: (() => Promise<string | null>) | null): void {
  reauthorize = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** 인증이 필요 없는 요청(bootstrap)만 false 로 둔다. */
  authorized?: boolean;
  /** 401 재시도 여부. 내부 재귀 방지용이다. */
  retryOnUnauthorized?: boolean;
}

async function parseError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope = {
    code: 'UNKNOWN',
    message: '알 수 없는 오류가 발생했어요.',
    requestId: response.headers.get('x-request-id') ?? '',
    retryable: response.status >= 500,
  };

  try {
    const parsed = (await response.json()) as Partial<ErrorEnvelope>;
    if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
      envelope = {
        code: parsed.code,
        message: parsed.message,
        requestId: parsed.requestId ?? envelope.requestId,
        retryable: parsed.retryable ?? envelope.retryable,
      };
    }
  } catch {
    // 본문이 JSON 이 아니면 기본 envelope 를 쓴다.
  }

  return new ApiError(response.status, envelope);
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, authorized = true, retryOnUnauthorized = true } = options;

  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  if (authorized && accessToken != null) headers.authorization = `Bearer ${accessToken}`;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // 쿠키를 쓰지 않는다. Bearer 토큰만 사용한다 (공통 06 §4).
      credentials: 'omit',
    });
  } catch {
    throw new NetworkError();
  }

  if (response.status === 401 && authorized && retryOnUnauthorized && reauthorize != null) {
    // 토큰이 만료됐다. refresh token 은 없으므로 bootstrap 을 다시 한다.
    const renewed = await reauthorize();
    if (renewed != null) {
      return await request<T>(path, { ...options, retryOnUnauthorized: false });
    }
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
