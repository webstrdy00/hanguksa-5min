import { ZodError } from 'zod';
import { AppError, toErrorEnvelope } from './errors.ts';
import type { AppInstance } from './types.ts';

/**
 * 모든 오류 응답을 공통 envelope 로 통일한다 (공통 05 §2).
 * 내부 예외 메시지/스택은 절대 응답에 싣지 않는다. 서버 로그에만 남긴다.
 */
export function registerErrorHandler(app: AppInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const error = new AppError('NOT_FOUND');
    void reply.status(error.status).send(toErrorEnvelope(error, request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = normalize(error);

    if (appError.status >= 500) {
      request.log.error({ err: error, code: appError.code }, 'request_failed');
    } else {
      request.log.warn({ code: appError.code, status: appError.status }, 'request_rejected');
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

  return new AppError('INTERNAL_ERROR', { cause: error });
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
