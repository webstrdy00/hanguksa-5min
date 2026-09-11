import { describe, expect, it } from 'vitest';
import { AppError, isRetryableStatus, sanitizeDetails, toErrorEnvelope } from './errors.ts';

describe('오류 코드 → HTTP status 매핑 (공통 05 §2)', () => {
  it('문서에 정의된 status 를 그대로 쓴다', () => {
    expect(new AppError('INVALID_REQUEST').status).toBe(400);
    expect(new AppError('AUTH_REQUIRED').status).toBe(401);
    expect(new AppError('INVALID_USER_KEY').status).toBe(401);
    expect(new AppError('FORBIDDEN').status).toBe(403);
    expect(new AppError('USER_DELETED').status).toBe(403);
    expect(new AppError('NOT_FOUND').status).toBe(404);
    expect(new AppError('STATE_CONFLICT').status).toBe(409);
    expect(new AppError('ALREADY_CLAIMED').status).toBe(409);
    expect(new AppError('ANSWER_ALREADY_SUBMITTED').status).toBe(422);
    expect(new AppError('IDEMPOTENCY_KEY_REUSED').status).toBe(422);
    expect(new AppError('PUBLISH_REQUIREMENTS_MISSING').status).toBe(422);
    expect(new AppError('RATE_LIMITED').status).toBe(429);
    expect(new AppError('DEPENDENCY_UNAVAILABLE').status).toBe(503);
    expect(new AppError('IDENTITY_PROVIDER_UNAVAILABLE').status).toBe(503);
    expect(new AppError('INTERNAL_ERROR').status).toBe(500);
  });
});

describe('retryable 판정', () => {
  it('429/503 만 재시도 대상이다', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(false);
    expect(isRetryableStatus(409)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
  });

  it('409/422 는 사용자 선택이 필요하므로 재시도 대상이 아니다', () => {
    expect(new AppError('STATE_CONFLICT').retryable).toBe(false);
    expect(new AppError('ANSWER_ALREADY_SUBMITTED').retryable).toBe(false);
    expect(new AppError('RATE_LIMITED').retryable).toBe(true);
    expect(new AppError('IDENTITY_PROVIDER_UNAVAILABLE').retryable).toBe(true);
  });
});

describe('sanitizeDetails (PII/UGC 차단)', () => {
  it('식별키·토큰·답변 원문 키를 제거한다', () => {
    const result = sanitizeDetails({
      anonKey: 'raw-anon-key',
      accessToken: 'token-value',
      inviteToken: 'invite',
      answerText: '사용자가 쓴 답변',
      authorization: 'Bearer x',
      questionId: 'q-1',
    });

    expect(result).toEqual({ questionId: 'q-1' });
  });

  it('중첩 객체와 배열 안에서도 제거한다', () => {
    const result = sanitizeDetails({
      session: { id: 's-1', anon_key: 'raw', items: [{ token: 't', index: 2 }] },
    });

    expect(result).toEqual({ session: { id: 's-1', items: [{ index: 2 }] } });
  });

  it('키 이름의 대소문자·구분자를 무시하고 판단한다', () => {
    const result = sanitizeDetails({ ANON_KEY: 'a', 'x-anon-key': 'b', Token: 'c', ok: 1 });
    expect(result).toEqual({ ok: 1 });
  });

  it('긴 문자열을 잘라낸다', () => {
    const long = 'ㄱ'.repeat(500);
    const result = sanitizeDetails({ note: long }) as { note: string };
    expect(result.note.length).toBeLessThanOrEqual(201);
    expect(result.note.endsWith('…')).toBe(true);
  });

  it('배열 길이와 깊이를 제한한다', () => {
    const result = sanitizeDetails({ items: Array.from({ length: 100 }, (_, i) => i) }) as {
      items: number[];
    };
    expect(result.items).toHaveLength(20);

    const deep = sanitizeDetails({
      l1: { l2: { l3: { l4: { l5: { l6: { l7: 'too deep' } } } } } },
    });
    expect(deep).toEqual({ l1: { l2: { l3: { l4: { l5: { l6: '[TRUNCATED]' } } } } } });
  });

  it('함수처럼 직렬화할 수 없는 값은 버린다', () => {
    const result = sanitizeDetails({ fn: () => 1, ok: true });
    expect(result).toEqual({ fn: undefined, ok: true });
  });
});

describe('toErrorEnvelope', () => {
  it('code / message / requestId / retryable 을 담는다', () => {
    const envelope = toErrorEnvelope(new AppError('RATE_LIMITED'), 'req-1');

    expect(envelope).toEqual({
      code: 'RATE_LIMITED',
      message: '요청이 너무 많아요. 잠시 후 다시 시도해주세요.',
      requestId: 'req-1',
      retryable: true,
    });
  });

  it('details 가 없으면 키 자체를 넣지 않는다', () => {
    const envelope = toErrorEnvelope(new AppError('NOT_FOUND'), 'req-2');
    expect('details' in envelope).toBe(false);
  });

  it('details 는 정제된 값만 내보낸다', () => {
    const envelope = toErrorEnvelope(
      new AppError('INVALID_REQUEST', { details: { field: 'grade', anonKey: 'raw' } }),
      'req-3',
    );

    expect(envelope.details).toEqual({ field: 'grade' });
  });

  it('개발용 code 와 사용자 노출 message 를 분리한다', () => {
    const error = new AppError('INTERNAL_ERROR');
    expect(error.message).toBe('INTERNAL_ERROR');
    expect(error.userMessage).toBe('알 수 없는 오류가 발생했어요.');
  });
});
