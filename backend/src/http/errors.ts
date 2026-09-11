/**
 * 공통 오류 계약.
 *
 * 근거: 공통 05 §2 / 공통 02 §8
 * - 응답 envelope: { code, message, requestId, retryable, details? }
 * - 사용자에게 보여줄 message 와 개발용 code 를 분리한다.
 * - 재시도는 429/503 에서만 허용한다. 409/422 는 상태를 갱신하고 사용자가 선택해야 한다.
 * - details 에 답변 원문 / anonKey / token 을 넣지 않는다.
 */

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTH_REQUIRED'
  | 'INVALID_USER_KEY'
  | 'FORBIDDEN'
  | 'USER_DELETED'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'ALREADY_CLAIMED'
  | 'ANSWER_ALREADY_SUBMITTED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PUBLISH_REQUIREMENTS_MISSING'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'IDENTITY_PROVIDER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

interface ErrorDefinition {
  readonly status: number;
  /** 사용자에게 그대로 보여줘도 되는 문구. 원인/내부 구조를 드러내지 않는다. */
  readonly message: string;
}

export const ERROR_DEFINITIONS: Readonly<Record<ErrorCode, ErrorDefinition>> = {
  INVALID_REQUEST: { status: 400, message: '요청 형식이 올바르지 않아요.' },
  AUTH_REQUIRED: { status: 401, message: '로그인 정보가 필요해요. 앱을 다시 열어주세요.' },
  INVALID_USER_KEY: { status: 401, message: '사용자 확인에 실패했어요. 앱을 다시 열어주세요.' },
  FORBIDDEN: { status: 403, message: '권한이 없어요.' },
  USER_DELETED: { status: 403, message: '삭제된 계정이에요.' },
  NOT_FOUND: { status: 404, message: '요청한 정보를 찾을 수 없어요.' },
  STATE_CONFLICT: {
    status: 409,
    message: '상태가 이미 바뀌었어요. 새로고침 후 다시 시도해주세요.',
  },
  ALREADY_CLAIMED: { status: 409, message: '이미 처리된 요청이에요.' },
  ANSWER_ALREADY_SUBMITTED: { status: 422, message: '이미 제출한 답변이에요.' },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    message: '같은 요청 키로 다른 내용을 보낼 수 없어요.',
  },
  PUBLISH_REQUIREMENTS_MISSING: {
    status: 422,
    message: '출처와 검수 정보가 있어야 발행할 수 있어요.',
  },
  RATE_LIMITED: { status: 429, message: '요청이 너무 많아요. 잠시 후 다시 시도해주세요.' },
  DEPENDENCY_UNAVAILABLE: {
    status: 503,
    message: '일시적인 오류예요. 잠시 후 다시 시도해주세요.',
  },
  IDENTITY_PROVIDER_UNAVAILABLE: {
    status: 503,
    message: '일시적인 오류예요. 잠시 후 다시 시도해주세요.',
  },
  INTERNAL_ERROR: { status: 500, message: '알 수 없는 오류가 발생했어요.' },
};

/** 공통 05 §2: 429/503 만 지수 백오프 재시도 대상이다. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
  details?: unknown;
}

/**
 * details 에 절대 들어가면 안 되는 키.
 * 공통 05 §2 / 하드게이트: PII/UGC/식별키/토큰은 오류 응답에 포함하지 않는다.
 */
const FORBIDDEN_DETAIL_KEYS = [
  'anonkey',
  'anonkeyvalue',
  'accesstoken',
  'token',
  'invitetoken',
  'challengetoken',
  'authorization',
  'cookie',
  'password',
  'secret',
  'privatekey',
  'certificate',
  'answer',
  'answertext',
  'prompt',
  'explanation',
];

const MAX_DETAIL_DEPTH = 6;
const MAX_DETAIL_ARRAY_ITEMS = 20;
const MAX_DETAIL_STRING_LENGTH = 200;

function isForbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  return FORBIDDEN_DETAIL_KEYS.some((forbidden) => normalized.includes(forbidden));
}

/**
 * 오류 details 를 안전한 형태로 정리한다.
 * - 금지 키는 통째로 제거한다.
 * - 문자열/배열/깊이를 제한해 로그·응답 폭주를 막는다.
 */
export function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth >= MAX_DETAIL_DEPTH) return '[TRUNCATED]';

  if (typeof value === 'string') {
    return value.length > MAX_DETAIL_STRING_LENGTH
      ? `${value.slice(0, MAX_DETAIL_STRING_LENGTH)}…`
      : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_ARRAY_ITEMS).map((item) => sanitizeDetails(item, depth + 1));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenKey(key)) continue;
      result[key] = sanitizeDetails(item, depth + 1);
    }
    return result;
  }

  return undefined;
}

/**
 * 서비스 전역에서 사용하는 오류 타입.
 * throw new AppError('STATE_CONFLICT') 처럼 코드만 던지면 status/message/retryable 이 계약대로 결정된다.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    code: ErrorCode,
    options: { details?: unknown; cause?: unknown; userMessage?: string } = {},
  ) {
    const definition = ERROR_DEFINITIONS[code];
    // Error.message 는 개발용이다. 사용자 노출 문구는 userMessage 를 쓴다.
    super(code, options.cause == null ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = definition.status;
    this.userMessage = options.userMessage ?? definition.message;
    this.retryable = isRetryableStatus(definition.status);
    this.details = options.details === undefined ? undefined : sanitizeDetails(options.details);
  }
}

export function toErrorEnvelope(error: AppError, requestId: string): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    code: error.code,
    message: error.userMessage,
    requestId,
    retryable: error.retryable,
  };
  if (error.details !== undefined) {
    envelope.details = error.details;
  }
  return envelope;
}
