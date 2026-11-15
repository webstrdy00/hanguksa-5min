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
  address: 'MOCK-private-db-host',
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

function drizzleError(cause: Error): DrizzleQueryError {
  return new DrizzleQueryError(MOCK_SENSITIVE.query, [MOCK_SENSITIVE.param], cause);
}

function wrappedQuota(): DrizzleQueryError {
  return drizzleError(postgresError(QUOTA_MESSAGE, MOCK_SENSITIVE.code));
}

function connectionError(
  code: postgres.ConnectionError['code'],
  address: string | string[] = MOCK_SENSITIVE.address,
): Error {
  // postgres.js src/errors.js 의 ConnectionError 형태 (PostgresError 인스턴스가 아님).
  return Object.assign(new Error(`write ${code} ${MOCK_SENSITIVE.address}:5432`), {
    code,
    errno: code,
    address,
    port: Array.isArray(address) ? [5432] : 5432,
    stack: MOCK_SENSITIVE.stack,
    cause: new Error(MOCK_SENSITIVE.cause),
  });
}

function socketError(code: string, errno: number, syscall: string): Error {
  return Object.assign(new Error(MOCK_SENSITIVE.message), {
    code,
    errno,
    syscall,
    address: MOCK_SENSITIVE.address,
    port: 5432,
    stack: MOCK_SENSITIVE.stack,
    cause: new Error(MOCK_SENSITIVE.cause),
  });
}

function driverQueryError<T extends Error>(error: T): T {
  // postgres.js queryError() 는 Node 오류를 그대로 쓰고 비열거 속성을 붙인다.
  return Object.defineProperties(error, {
    query: { value: MOCK_SENSITIVE.query },
    parameters: { value: [MOCK_SENSITIVE.param] },
  });
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

  it('code 를 가진 wrapper 안의 정확한 Postgres quota 분류도 유지한다', async () => {
    const error = Object.assign(new Error(MOCK_SENSITIVE.message, { cause: wrappedQuota() }), {
      code: MOCK_SENSITIVE.code,
    });
    expectFailure(await injectError(error), DEPENDENCY_UNAVAILABLE);
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

describe('PostgreSQL 일시 연결 장애와 개인정보 안전 로깅', () => {
  it.each(['CONNECT_TIMEOUT', 'CONNECTION_CLOSED'] as const)(
    '실제 postgres.js 형태의 %s 를 직접 또는 Drizzle cause 에서 503 으로 변환한다',
    async (code) => {
      expectFailure(await injectError(connectionError(code)), DEPENDENCY_UNAVAILABLE);
      const error = new Error(MOCK_SENSITIVE.message, {
        cause: drizzleError(connectionError(code)),
      });
      expectFailure(await injectError(error), DEPENDENCY_UNAVAILABLE);
    },
  );

  it('socket 종료 후 options.host 배열을 가진 실제 CONNECTION_CLOSED 형태도 503 이다', async () => {
    const error = connectionError('CONNECTION_CLOSED', [MOCK_SENSITIVE.address]);
    expectFailure(await injectError(error), DEPENDENCY_UNAVAILABLE);
    expectFailure(await injectError(drizzleError(error)), DEPENDENCY_UNAVAILABLE);
  });

  it('TLS socket 에 host 가 없는 연결 시간초과는 DB 쿼리 근거가 있을 때만 503 이다', async () => {
    const error = Object.assign(connectionError('CONNECT_TIMEOUT'), { address: undefined });
    expectFailure(await injectError(error), INTERNAL_ERROR);
    expectFailure(await injectError(drizzleError(error)), DEPENDENCY_UNAVAILABLE);
    expectFailure(await injectError(driverQueryError(error)), DEPENDENCY_UNAVAILABLE);
  });

  it.each([
    ['ECONNREFUSED', -111, 'connect'],
    ['ECONNRESET', -104, 'read'],
    ['ETIMEDOUT', -110, 'connect'],
    ['EPIPE', -32, 'write'],
    ['EHOSTUNREACH', -113, 'connect'],
    ['ENETUNREACH', -101, 'connect'],
    ['EAI_AGAIN', -3001, 'getaddrinfo'],
  ] as const)('DB 쿼리에서 발생한 Node %s 는 503 이다', async (code, errno, syscall) => {
    const direct = driverQueryError(socketError(code, errno, syscall));
    expectFailure(await injectError(direct), DEPENDENCY_UNAVAILABLE);
    const wrapped = new Error(MOCK_SENSITIVE.message, {
      cause: drizzleError(socketError(code, errno, syscall)),
    });
    expectFailure(await injectError(wrapped), DEPENDENCY_UNAVAILABLE);

    // 같은 Node 오류라도 DB 발생 근거가 없으면 외부 API/애플리케이션 장애일 수 있다.
    expectFailure(await injectError(socketError(code, errno, syscall)), INTERNAL_ERROR);
  });

  it('Drizzle 이 감싼 Node 다중 주소 연결 실패도 최상위 code 로 분류한다', async () => {
    const error = Object.assign(
      new AggregateError([socketError('ECONNREFUSED', -111, 'connect')], MOCK_SENSITIVE.message),
      { code: 'ECONNREFUSED' },
    );
    expectFailure(await injectError(drizzleError(error)), DEPENDENCY_UNAVAILABLE);
  });

  it.each(['08006', '53300', '57P01', '57P02', '57P03'])(
    '실제 PostgresError 의 서버 가용성 SQLSTATE %s 는 503 이다',
    async (code) => {
      expectFailure(
        await injectError(postgresError(MOCK_SENSITIVE.message, code)),
        DEPENDENCY_UNAVAILABLE,
      );
      expectFailure(
        await injectError(drizzleError(postgresError(MOCK_SENSITIVE.message, code))),
        DEPENDENCY_UNAVAILABLE,
      );
    },
  );

  it('분류할 때 SQL/파라미터 속성 값을 읽거나 로그로 직렬화하지 않는다', async () => {
    const error = Object.defineProperties(socketError('ECONNRESET', -104, 'read'), {
      query: {
        get() {
          throw new Error(MOCK_SENSITIVE.query);
        },
      },
      parameters: {
        get() {
          throw new Error(MOCK_SENSITIVE.param);
        },
      },
    });
    expectFailure(await injectError(error), DEPENDENCY_UNAVAILABLE);
  });

  it('연결 오류를 찾은 뒤의 순환 cause 를 순회하지 않는다', async () => {
    const error = connectionError('CONNECTION_CLOSED');
    const wrapper = drizzleError(error);
    error.cause = wrapper;
    expectFailure(await injectError(wrapper), DEPENDENCY_UNAVAILABLE);
  });

  it.each([
    { wrappers: 15, expected: DEPENDENCY_UNAVAILABLE },
    { wrappers: 16, expected: INTERNAL_ERROR },
  ])(
    '연결 오류도 16개 Error 깊이 제한을 지킨다 ($wrappers wrappers)',
    async ({ wrappers, expected }) => {
      let error: Error = connectionError('CONNECT_TIMEOUT');
      for (let index = 0; index < wrappers; index++) {
        error = new Error(MOCK_SENSITIVE.message, { cause: error });
      }
      expectFailure(await injectError(error), expected);
    },
  );
});

describe('일시 DB 장애로 오인하면 안 되는 오류', () => {
  it.each([
    '08000', // 일반 연결 예외는 일시 장애로 단정하지 않는다.
    '08001',
    '08003',
    '08004', // 연결 거부는 인증/접속 정책 문제일 수도 있다.
    '08007',
    '08P01', // 프로토콜 오류
    '28P01', // 비밀번호 오류
    '28000', // 인증/접속 정책 오류
    '3D000', // 존재하지 않는 DB
    '42501', // 권한 부족
    '53400', // 설정 한도 초과
    'F0000', // 설정 파일 오류
    '57P04', // 삭제된 DB
    '57014', // 명시적 쿼리 취소
    '40001', // 직렬화 실패는 연결 장애가 아님
  ])('다른 PostgreSQL SQLSTATE %s 는 500 이다', async (code) => {
    const error = drizzleError(postgresError(MOCK_SENSITIVE.message, code));
    expectFailure(await injectError(error), INTERNAL_ERROR);
  });

  it.each([
    'ENOTFOUND',
    'ENOENT',
    'EACCES',
    'EINVAL',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SASL_SIGNATURE_MISMATCH',
    'AUTH_TYPE_NOT_IMPLEMENTED',
    'UNDEFINED_VALUE',
    MOCK_SENSITIVE.code,
  ])('DB 쿼리의 설정/인증/TLS/알 수 없는 code %s 는 500 이다', async (code) => {
    const error = driverQueryError(socketError(code, -1, 'connect'));
    expectFailure(await injectError(drizzleError(error)), INTERNAL_ERROR);
  });

  it.each(['CONNECTION_ENDED', 'CONNECTION_DESTROYED'] as const)(
    '명시적 sql.end() 에 따른 %s 는 500 이다',
    async (code) => {
      expectFailure(await injectError(drizzleError(connectionError(code))), INTERNAL_ERROR);
    },
  );

  it.each(['08006', '53300', '57P03', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED'])(
    'code/이름/문구만 흉내 낸 일반 Error %s 는 500 이다',
    async (code) => {
      const error = Object.assign(new Error('MOCK database connection unavailable'), {
        name: 'PostgresError',
        code,
      });
      expectFailure(await injectError(drizzleError(error)), INTERNAL_ERROR);
    },
  );

  it('Error 가 아닌 연결 오류 cause 객체는 따라가지 않는다', async () => {
    const error = drizzleError(
      new Error(MOCK_SENSITIVE.message, {
        cause: { code: 'ECONNRESET', cause: connectionError('CONNECT_TIMEOUT') },
      }),
    );
    expectFailure(await injectError(error), INTERNAL_ERROR);
  });

  it('연결 오류 없는 Drizzle 순환 체인도 안전하게 500 으로 종료한다', async () => {
    const first = new Error(MOCK_SENSITIVE.message);
    const second = drizzleError(first);
    first.cause = second;
    expectFailure(await injectError(second), INTERNAL_ERROR);
  });

  it.each(['42601', '23505', '28P01'])(
    'SQL/무결성/인증 오류 %s 의 내부 연결 cause 로 503 을 만들지 않는다',
    async (code) => {
      const error = postgresError(MOCK_SENSITIVE.message, code);
      error.cause = connectionError('CONNECT_TIMEOUT');
      expectFailure(await injectError(drizzleError(error)), INTERNAL_ERROR);
    },
  );

  it('TLS 인증서 오류의 내부 연결 cause 로 503 을 만들지 않는다', async () => {
    const error = Object.assign(new Error(MOCK_SENSITIVE.message), {
      code: 'CERT_HAS_EXPIRED',
      cause: connectionError('CONNECTION_CLOSED'),
    });
    expectFailure(await injectError(drizzleError(error)), INTERNAL_ERROR);
  });

  it('명시적인 AppError 는 연결 cause 가 있어도 유지한다', async () => {
    const error = new AppError('INTERNAL_ERROR', {
      cause: drizzleError(connectionError('CONNECT_TIMEOUT')),
    });
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
