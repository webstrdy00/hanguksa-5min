import { randomUUID } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm';
import Fastify from 'fastify';
import { pino } from 'pino';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { registerErrorHandler } from './error-handler.ts';
import { AppError, type ErrorEnvelope } from './errors.ts';

const QUOTA_MESSAGE =
  'Your account or project has exceeded the quota. Upgrade your plan to increase limits.';
const MOCK_SENSITIVE = {
  query: 'select MOCK_private_column from MOCK_users where MOCK_anon_key = $1',
  param: 'MOCK-private-anonKey-and-token',
  message: 'MOCK-private-error-message',
  stack: 'MOCK-private-error-stack',
  cause: 'MOCK-private-cause-message',
  detail: 'MOCK-private-postgres-detail',
  code: 'MOCK-untrusted-error-code',
  requestId: 'MOCK-client-supplied-request-id',
};

const INTERNAL_ERROR = {
  status: 500,
  code: 'INTERNAL_ERROR',
  message: '알 수 없는 오류가 발생했어요.',
  retryable: false,
} as const;
const DEPENDENCY_UNAVAILABLE = {
  status: 503,
  code: 'DEPENDENCY_UNAVAILABLE',
  message: '일시적인 오류예요. 잠시 후 다시 시도해주세요.',
  retryable: true,
} as const;

function postgresError(message: string, code = 'XX000'): postgres.PostgresError {
  // postgres 3.4.9 런타임은 필드 객체를 받지만 타입 선언은 Error 생성자를 상속한다.
  return Reflect.construct(postgres.PostgresError, [
    {
      message,
      code,
      query: MOCK_SENSITIVE.query,
      parameters: [MOCK_SENSITIVE.param],
      detail: MOCK_SENSITIVE.detail,
      stack: MOCK_SENSITIVE.stack,
      cause: new Error(MOCK_SENSITIVE.cause),
      untrusted: MOCK_SENSITIVE.message,
    },
  ]) as postgres.PostgresError;
}

function wrappedQuota(): DrizzleQueryError {
  return new DrizzleQueryError(
    MOCK_SENSITIVE.query,
    [MOCK_SENSITIVE.param],
    postgresError(QUOTA_MESSAGE, MOCK_SENSITIVE.code),
  );
}

async function injectError(error: Error, url = '/MOCK-error') {
  const logs: Record<string, unknown>[] = [];
  const logger = pino(
    {
      level: 'trace',
      base: null,
      timestamp: false,
      formatters: { level: (level) => ({ level }) },
    },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
  });
  registerErrorHandler(app);
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-request-id', request.id);
    done(null, payload);
  });
  app.get('/MOCK-error', () => {
    throw error;
  });
  app.get(
    '/MOCK-validation',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['grade'],
          properties: { grade: { type: 'integer' } },
        },
      },
    },
    (_request, reply) => reply.send({ ok: true }),
  );

  try {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: {
        authorization: `Bearer ${MOCK_SENSITIVE.param}`,
        'x-request-id': MOCK_SENSITIVE.requestId,
      },
    });
    return { response, logs };
  } finally {
    await app.close();
  }
}

function expectFailure(
  { response, logs }: Awaited<ReturnType<typeof injectError>>,
  expected: Omit<ErrorEnvelope, 'requestId'> & { status: number },
  logged = true,
): void {
  const { status, ...envelope } = expected;
  const requestId = response.headers['x-request-id'];
  expect(response.statusCode).toBe(status);
  expect(requestId).toEqual(expect.any(String));
  expect(requestId).not.toBe(MOCK_SENSITIVE.requestId);
  expect(response.json<ErrorEnvelope>()).toEqual({ ...envelope, requestId });
  expect(logs).toEqual(
    logged
      ? [
          {
            level: status >= 500 ? 'error' : 'warn',
            reqId: requestId,
            category: status >= 500 ? 'server_error' : 'client_error',
            code: envelope.code,
            status,
            requestId,
            msg: status >= 500 ? 'request_failed' : 'request_rejected',
          },
        ]
      : [],
  );

  const output = JSON.stringify({ logs, response: response.body });
  for (const sensitive of [...Object.values(MOCK_SENSITIVE), QUOTA_MESSAGE]) {
    expect(output).not.toContain(sensitive);
  }
}

describe('PostgreSQL quota 오류와 개인정보 안전 로깅', () => {
  it('실제 Drizzle/Postgres cause 체인을 503 재시도 envelope 로 변환한다', async () => {
    const error = new Error(MOCK_SENSITIVE.message, { cause: wrappedQuota() });
    expectFailure(await injectError(error), DEPENDENCY_UNAVAILABLE);
  });

  it('직접 발생한 Postgres quota 오류도 처리한다', async () => {
    expectFailure(await injectError(postgresError(QUOTA_MESSAGE)), DEPENDENCY_UNAVAILABLE);
  });

  it.each([
    ['42P01', 'MOCK relation does not exist'],
    ['23505', 'MOCK duplicate key violates unique constraint'],
    ['42601', 'MOCK syntax error'],
    ['XX000', MOCK_SENSITIVE.message],
    ['XX000', `${QUOTA_MESSAGE} ${MOCK_SENSITIVE.message}`],
  ])('무관한 DB 오류 %s 는 500 을 유지한다', async (code, message) => {
    const error = new DrizzleQueryError(
      MOCK_SENSITIVE.query,
      [MOCK_SENSITIVE.param],
      postgresError(message, code),
    );
    expectFailure(await injectError(error), INTERNAL_ERROR);
  });

  it.each([
    new Error(QUOTA_MESSAGE),
    new Error(`${MOCK_SENSITIVE.message}: exceeded the quota`),
    Object.assign(new Error(QUOTA_MESSAGE), { name: 'PostgresError', code: 'XX000' }),
  ])('quota 문구나 PostgresError 이름만 가진 일반 Error 는 500 이다 (%#)', async (error) => {
    const wrapped = new DrizzleQueryError(MOCK_SENSITIVE.query, [MOCK_SENSITIVE.param], error);
    expectFailure(await injectError(wrapped), INTERNAL_ERROR);
  });

  it('Error 가 아닌 cause 객체의 속성을 따라가지 않는다', async () => {
    const error = new Error(MOCK_SENSITIVE.message, {
      cause: { cause: postgresError(QUOTA_MESSAGE), params: [MOCK_SENSITIVE.param] },
    });
    expectFailure(await injectError(error), INTERNAL_ERROR);
  });

  it('순환 cause 체인도 종료하고 원문 없이 500 을 반환한다', async () => {
    const first = new Error(MOCK_SENSITIVE.message);
    const second = new DrizzleQueryError(MOCK_SENSITIVE.query, [MOCK_SENSITIVE.param], first);
    first.cause = second;
    expectFailure(await injectError(first), INTERNAL_ERROR);
  });

  it.each([
    { wrappers: 15, expected: DEPENDENCY_UNAVAILABLE },
    { wrappers: 16, expected: INTERNAL_ERROR },
  ])(
    'cause 검사 깊이를 16개 Error 로 제한한다 ($wrappers wrappers)',
    async ({ wrappers, expected }) => {
      let error: Error = postgresError(QUOTA_MESSAGE);
      for (let index = 0; index < wrappers; index++) {
        error = new Error(MOCK_SENSITIVE.message, { cause: error });
      }
      expectFailure(await injectError(error), expected);
    },
  );

  it('명시적인 INTERNAL_ERROR 를 quota cause 때문에 503 으로 덮지 않는다', async () => {
    const error = new AppError('INTERNAL_ERROR', { cause: wrappedQuota() });
    expectFailure(await injectError(error), INTERNAL_ERROR);
  });
});

describe('기존 오류와 라우팅 계약', () => {
  it('AppError 의 status/details 를 유지하고 원문 cause 는 로깅하지 않는다', async () => {
    const error = new AppError('STATE_CONFLICT', {
      details: { field: 'grade', token: MOCK_SENSITIVE.param },
      cause: new Error(MOCK_SENSITIVE.cause),
    });
    expectFailure(await injectError(error), {
      status: 409,
      code: 'STATE_CONFLICT',
      message: '상태가 이미 바뀌었어요. 새로고침 후 다시 시도해주세요.',
      retryable: false,
      details: { field: 'grade' },
    });
  });

  it('기존 IDENTITY_PROVIDER_UNAVAILABLE 코드를 유지한다', async () => {
    const error = new AppError('IDENTITY_PROVIDER_UNAVAILABLE', {
      cause: new Error(MOCK_SENSITIVE.cause),
    });
    expectFailure(await injectError(error), {
      ...DEPENDENCY_UNAVAILABLE,
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    });
  });

  it('Zod 오류의 필드별 details 계약을 유지한다', async () => {
    const error = new ZodError([
      {
        code: 'custom',
        path: ['goal', 'grade'],
        message: '급수를 확인해주세요.',
      },
    ]);
    expectFailure(await injectError(error), {
      status: 400,
      code: 'INVALID_REQUEST',
      message: '요청 형식이 올바르지 않아요.',
      retryable: false,
      details: { issues: [{ path: 'goal.grade', message: '급수를 확인해주세요.' }] },
    });
  });

  it.each([
    {
      statusCode: 429,
      status: 429,
      code: 'RATE_LIMITED',
      message: '요청이 너무 많아요. 잠시 후 다시 시도해주세요.',
      retryable: true,
    },
    {
      statusCode: 404,
      status: 404,
      code: 'NOT_FOUND',
      message: '요청한 정보를 찾을 수 없어요.',
      retryable: false,
    },
    {
      statusCode: 403,
      status: 400,
      code: 'INVALID_REQUEST',
      message: '요청 형식이 올바르지 않아요.',
      retryable: false,
    },
  ] as const)('Fastify status $statusCode 매핑을 유지한다', async ({ statusCode, ...expected }) => {
    const error = Object.assign(new Error(MOCK_SENSITIVE.message), { statusCode });
    expectFailure(await injectError(error), expected);
  });

  it('실제 Fastify 스키마 검증 오류는 400 이다', async () => {
    expectFailure(await injectError(new Error(MOCK_SENSITIVE.message), '/MOCK-validation'), {
      status: 400,
      code: 'INVALID_REQUEST',
      message: '요청 형식이 올바르지 않아요.',
      retryable: false,
    });
  });

  it('없는 경로는 기존 NOT_FOUND envelope 를 유지한다', async () => {
    expectFailure(
      await injectError(new Error(MOCK_SENSITIVE.message), '/MOCK-missing'),
      {
        status: 404,
        code: 'NOT_FOUND',
        message: '요청한 정보를 찾을 수 없어요.',
        retryable: false,
      },
      false,
    );
  });
});
