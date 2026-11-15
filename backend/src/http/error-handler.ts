import { DrizzleQueryError } from 'drizzle-orm';
import postgres from 'postgres';
import { ZodError } from 'zod';
import { AppError, toErrorEnvelope } from './errors.ts';
import type { AppInstance } from './types.ts';

const POSTGRES_QUOTA_MESSAGE =
  'Your account or project has exceeded the quota. Upgrade your plan to increase limits.';
// SQLSTATE 전체 클래스가 아닌 연결 실패·서버 중단·연결 수 고갈만 허용한다.
const POSTGRES_UNAVAILABLE_CODES = new Set(['08006', '53300', '57P01', '57P02', '57P03']);
// CONNECTION_ENDED/DESTROYED 는 sql.end() 에 의한 종료이므로 제외한다.
const POSTGRES_CONNECTION_CODES = new Set(['CONNECT_TIMEOUT', 'CONNECTION_CLOSED']);
const SOCKET_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);
const MAX_CAUSE_DEPTH = 16;

/**
 * 모든 오류 응답을 공통 envelope 로 통일한다 (공통 05 §2).
 * 내부 예외 메시지/스택/쿼리는 응답과 로그에 싣지 않는다 (공통 06 §1).
 */
export function registerErrorHandler(app: AppInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const error = new AppError('NOT_FOUND');
    void reply.status(error.status).send(toErrorEnvelope(error, request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = normalize(error);
    const logFields = {
      category: appError.status >= 500 ? 'server_error' : 'client_error',
      code: appError.code,
      status: appError.status,
      requestId: request.id,
    };

    if (appError.status >= 500) {
      request.log.error(logFields, 'request_failed');
    } else {
      request.log.warn(logFields, 'request_rejected');
    }

    void reply.status(appError.status).send(toErrorEnvelope(appError, request.id));
  });
}

function normalize(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError('INVALID_REQUEST', {
      cause: error,
      // 값이 아니라 "어느 필드가 왜 틀렸는지"만 내려보낸다.
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }

  if (isFastifyError(error)) {
    if (error.validation != null) {
      return new AppError('INVALID_REQUEST', { cause: error });
    }
    if (error.statusCode === 429) {
      return new AppError('RATE_LIMITED', { cause: error });
    }
    if (error.statusCode === 404) {
      return new AppError('NOT_FOUND', { cause: error });
    }
    if (error.statusCode != null && error.statusCode >= 400 && error.statusCode < 500) {
      return new AppError('INVALID_REQUEST', { cause: error });
    }
  }

  if (isPostgresUnavailable(error)) {
    return new AppError('DEPENDENCY_UNAVAILABLE', { cause: error });
  }

  return new AppError('INTERNAL_ERROR', { cause: error });
}

function isPostgresUnavailable(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  let fromDrizzle = false;
  let terminalFailure = false;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);

    // 기존 quota 분류는 coded wrapper 안에서도 같은 깊이 제한으로 유지한다.
    if (current instanceof postgres.PostgresError && current.message === POSTGRES_QUOTA_MESSAGE) {
      return true;
    }
    if (terminalFailure) {
      current = current.cause;
      continue;
    }

    if (current instanceof postgres.PostgresError) {
      if (POSTGRES_UNAVAILABLE_CODES.has(current.code)) return true;
      terminalFailure = true;
    }

    fromDrizzle ||= current instanceof DrizzleQueryError;
    if (!terminalFailure && 'code' in current && typeof current.code === 'string') {
      const fromQuery =
        fromDrizzle || (Object.hasOwn(current, 'query') && Object.hasOwn(current, 'parameters'));
      // postgres.js ConnectionError 는 별도 클래스가 없는 Error 이다.
      // socket 이 닫힌 뒤에는 address 에 options.host 배열이 들어갈 수도 있다.
      // TLS socket 교체 후 host 가 없는 경우는 DB 쿼리 근거가 있을 때만 허용한다.
      if (
        POSTGRES_CONNECTION_CODES.has(current.code) &&
        'errno' in current &&
        current.errno === current.code &&
        'address' in current &&
        (typeof current.address === 'string' ||
          Array.isArray(current.address) ||
          (current.address === undefined && fromQuery))
      ) {
        return true;
      }

      // Node socket 오류는 그대로 전달된다. 다른 외부 API/앱 오류와 구분하려고
      // Drizzle cause 또는 postgres.js 가 붙인 쿼리 속성의 존재만 확인한다.
      // SQL/파라미터 값은 읽지 않는다. DNS 오설정·인증·TLS 인증서 오류도 제외한다.
      if (SOCKET_UNAVAILABLE_CODES.has(current.code) && fromQuery) {
        return true;
      }
      // SQL/인증/TLS 등 명시된 실패를 안쪽 연결 cause 때문에 일시 장애로 바꾸지 않는다.
      terminalFailure = true;
    }

    current = current.cause;
  }

  return false;
}

interface FastifyErrorLike {
  statusCode?: number;
  validation?: unknown;
}

function isFastifyError(error: unknown): error is FastifyErrorLike {
  return (
    typeof error === 'object' && error != null && ('statusCode' in error || 'validation' in error)
  );
}
