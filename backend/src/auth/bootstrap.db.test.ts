import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import { env } from '../config/env.ts';
import { createTestClient, truncateAll } from '../db/test-helpers.ts';
import * as deletionJournal from '../deletion-journal/runtime.ts';
import { AppError } from '../http/errors.ts';
import type { AppInstance } from '../http/types.ts';
import { buildFingerprintCandidates } from './fingerprint.ts';
import type { IdentityProvider, VerificationOutcome } from './identity-provider.ts';
import { issueAccessToken } from './token.ts';

/**
 * bootstrap 인증 플로우 통합 테스트.
 *
 * 검증 API 는 스텁으로 대체하고, 그 외(DB, 토큰, 미들웨어, 레이트리밋)는 전부 실제로 돈다.
 */
class StubIdentityProvider implements IdentityProvider {
  readonly name = 'stub';
  calls = 0;
  outcome: VerificationOutcome = { status: 'valid' };

  verifyAnonKey(): Promise<VerificationOutcome> {
    this.calls += 1;
    return Promise.resolve(this.outcome);
  }
}

let sql: postgres.Sql;
let app: AppInstance;
let provider: StubIdentityProvider;

async function bootstrap(anonKey: string, appVersion?: string) {
  return await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: appVersion == null ? { anonKey } : { anonKey, appVersion },
  });
}

beforeAll(() => {
  sql = createTestClient();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await truncateAll(sql);
  provider = new StubIdentityProvider();
  // 테스트마다 새 앱을 만든다. 레이트리밋 카운터가 테스트 사이에 누적되지 않게 한다.
  app = await buildApp({ identityProvider: provider });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/auth/bootstrap', () => {
  it('처음 보는 식별키는 검증 후 계정을 만들고 토큰을 발급한다', async () => {
    const response = await bootstrap('anon-key-new-user');

    expect(response.statusCode).toBe(201);
    expect(provider.calls).toBe(1);

    const body = response.json<{ accessToken: string; expiresIn: number; tokenType: string }>();
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(env.INTERNAL_TOKEN_TTL_SECONDS);
    expect(body.accessToken.split('.')).toHaveLength(3);

    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(row?.count).toBe('1');
  });

  it('재접속에는 검증 API 를 호출하지 않는다 (앱당 3000 QPM 보호)', async () => {
    await bootstrap('anon-key-returning');
    expect(provider.calls).toBe(1);

    const second = await bootstrap('anon-key-returning');
    expect(second.statusCode).toBe(200);
    expect(provider.calls).toBe(1);

    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(row?.count).toBe('1');
  });

  it('검증 결과가 무효면 401 이고 계정을 만들지 않는다', async () => {
    provider.outcome = { status: 'invalid', reason: 'not_verified' };

    const response = await bootstrap('anon-key-invalid');

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('INVALID_USER_KEY');

    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(row?.count).toBe('0');
  });

  it('앱인토스 한도 초과(4095)는 503 retryable 로 내려간다', async () => {
    provider.outcome = {
      status: 'unavailable',
      reason: 'provider_rate_limited',
      retryAfterSeconds: 10,
    };

    const response = await bootstrap('anon-key-provider-limited');
    const body = response.json<{ code: string; retryable: boolean }>();

    expect(response.statusCode).toBe(503);
    expect(body.code).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
    expect(body.retryable).toBe(true);
  });

  it('검증 API 타임아웃이면 503 이고 계정이 생기지 않는다', async () => {
    provider.outcome = { status: 'unavailable', reason: 'http_timeout' };

    const response = await bootstrap('anon-key-timeout');

    expect(response.statusCode).toBe(503);

    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(row?.count).toBe('0');
  });

  it('같은 식별키로 동시에 들어와도 계정은 하나만 만들어진다', async () => {
    const [first, second] = await Promise.all([
      bootstrap('anon-key-race'),
      bootstrap('anon-key-race'),
    ]);

    expect([200, 201]).toContain(first.statusCode);
    expect([200, 201]).toContain(second.statusCode);

    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(row?.count).toBe('1');
  });

  it('anonKey 원문을 DB 에 저장하지 않는다', async () => {
    const anonKey = 'anon-key-should-not-be-stored';
    await bootstrap(anonKey);

    const [row] = await sql<{ dump: string }[]>`
      select row_to_json(users)::text as dump from users limit 1
    `;

    expect(row?.dump).not.toContain(anonKey);
    expect(row?.dump).toContain('anon_key_fingerprint');
  });

  it('anonKey 원문을 응답에 담지 않는다', async () => {
    const anonKey = 'anon-key-not-in-response';
    const response = await bootstrap(anonKey);

    expect(response.body).not.toContain(anonKey);
  });

  it('형식이 틀린 요청은 400 이고 오류 details 에 값을 싣지 않는다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload: { anonKey: 'short' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('short');
    expect(response.json<{ code: string }>().code).toBe('INVALID_REQUEST');
  });

  it('appVersion 을 함께 받으면 사용자 정보에 기록한다', async () => {
    await bootstrap('anon-key-with-version', '1.2.3');

    const [row] = await sql<{ app_version: string | null }[]>`
      select app_version from users limit 1
    `;
    expect(row?.app_version).toBe('1.2.3');
  });
});

describe('계정 상태별 처리', () => {
  it('차단된 계정은 재접속해도 403 이다', async () => {
    await bootstrap('anon-key-blocked');
    await sql`update users set identity_status = 'blocked'`;

    const response = await bootstrap('anon-key-blocked');

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
  });

  it('삭제된 계정으로 다시 들어오면 매핑을 폐기하고 새 계정을 만든다', async () => {
    const first = await bootstrap('anon-key-deleted');
    expect(first.statusCode).toBe(201);

    const [before] = await sql<{ id: string }[]>`select id from users`;
    await sql`update users set identity_status = 'deleted', deleted_at = now()`;

    const second = await bootstrap('anon-key-deleted');
    expect(second.statusCode).toBe(201);

    const rows = await sql<{ id: string; identity_status: string; anon_key_fingerprint: string }[]>`
      select id, identity_status, anon_key_fingerprint from users order by created_at
    `;

    expect(rows).toHaveLength(2);
    // 예전 계정은 그대로 삭제 상태로 남고, 식별키 매핑만 끊긴다.
    expect(rows[0]?.id).toBe(before?.id);
    expect(rows[0]?.identity_status).toBe('deleted');
    expect(rows[0]?.anon_key_fingerprint).toContain('revoked:');
    expect(rows[1]?.identity_status).toBe('active');
  });
});

describe('pepper 회전', () => {
  const originalPepper = env.SERVER_PEPPER;
  const originalVersion = env.SERVER_PEPPER_VERSION;
  const originalPrevious = env.SERVER_PEPPER_PREVIOUS;

  afterEach(() => {
    env.SERVER_PEPPER = originalPepper;
    env.SERVER_PEPPER_VERSION = originalVersion;
    env.SERVER_PEPPER_PREVIOUS = originalPrevious;
  });

  it('pepper 를 바꿔도 기존 사용자를 잃지 않고 새 버전으로 이관한다', async () => {
    await bootstrap('anon-key-rotate');
    const [before] = await sql<{ id: string; anon_key_fingerprint: string }[]>`
      select id, anon_key_fingerprint from users
    `;

    // pepper 회전: 새 값을 쓰고 이전 값을 목록에 남긴다.
    env.SERVER_PEPPER_PREVIOUS = `${originalVersion}:${originalPepper}`;
    env.SERVER_PEPPER = 'rotated-pepper-value-for-tests-0123456789';
    env.SERVER_PEPPER_VERSION = originalVersion + 1;

    const response = await bootstrap('anon-key-rotate');

    expect(response.statusCode).toBe(200);
    // 구 버전으로 찾았으므로 검증 API 를 다시 부르지 않는다.
    expect(provider.calls).toBe(1);

    const rows = await sql<
      { id: string; anon_key_fingerprint: string; anon_key_fingerprint_version: number }[]
    >`select id, anon_key_fingerprint, anon_key_fingerprint_version from users`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before?.id);
    expect(rows[0]?.anon_key_fingerprint).not.toBe(before?.anon_key_fingerprint);
    expect(rows[0]?.anon_key_fingerprint_version).toBe(originalVersion + 1);
  });
});

describe('GET /v1/me (Bearer 인증)', () => {
  async function tokenFor(anonKey: string): Promise<string> {
    const response = await bootstrap(anonKey);
    return response.json<{ accessToken: string }>().accessToken;
  }

  it('유효한 토큰이면 내부 user_id 를 돌려준다', async () => {
    const token = await tokenFor('anon-key-me');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ userId: string }>().userId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('토큰이 없으면 401 이다', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('AUTH_REQUIRED');
  });

  it('만료된 토큰은 401 이다', async () => {
    await bootstrap('anon-key-expired');
    const [user] = await sql<{ id: string }[]>`select id from users`;
    const expired = await issueAccessToken(user!.id, new Date(Date.now() - 3_600_000));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${expired.token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('서명이 위조된 토큰은 401 이다', async () => {
    const token = await tokenFor('anon-key-forged');
    const parts = token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('토큰은 유효해도 계정이 삭제됐으면 403 이다 (즉시 무효화)', async () => {
    const token = await tokenFor('anon-key-revoked');
    await sql`update users set identity_status = 'deleted', deleted_at = now()`;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('USER_DELETED');
  });

  it('차단된 계정은 403 이다', async () => {
    const token = await tokenFor('anon-key-blocked-me');
    await sql`update users set identity_status = 'blocked'`;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
  });
});

describe('외부 삭제 의도 인증 차단', () => {
  beforeEach(() => {
    vi.spyOn(deletionJournal, 'isDeletionRequested').mockResolvedValue(false);
    vi.spyOn(deletionJournal, 'withLiveJournalSubject').mockImplementation(
      async (_userId, operation) => operation(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['USER_DELETED', 403],
    ['DEPENDENCY_UNAVAILABLE', 503],
  ] as const)('동의 쓰기 경계의 %s 오류는 동의를 기록하지 않는다', async (code, status) => {
    const first = await bootstrap('anon-key-journal-consent');
    const token = first.json<{ accessToken: string }>().accessToken;
    vi.mocked(deletionJournal.withLiveJournalSubject).mockRejectedValue(new AppError(code));

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/consent',
      headers: { authorization: `Bearer ${token}` },
      payload: { result: 'newAgreement' },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json<{ code: string }>().code).toBe(code);
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from notification_consents
    `;
    expect(row?.count).toBe('0');
  });

  it('동의 트랜잭션은 인증 이후 삭제된 주 DB 행을 잠금 상태로 재확인한다', async () => {
    const first = await bootstrap('anon-key-journal-consent-race');
    const token = first.json<{ accessToken: string }>().accessToken;
    vi.mocked(deletionJournal.withLiveJournalSubject).mockImplementation(
      async (_userId, operation) => {
        await sql`update users set identity_status = 'deleted', deleted_at = now()`;
        return await operation();
      },
    );

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/consent',
      headers: { authorization: `Bearer ${token}` },
      payload: { result: 'newAgreement' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('USER_DELETED');
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from notification_consents
    `;
    expect(row?.count).toBe('0');
  });

  it('DB 가 active 로 복원되거나 삭제 트랜잭션이 실패해도 기존 토큰과 재접속을 막는다', async () => {
    const first = await bootstrap('anon-key-journal-active');
    const token = first.json<{ accessToken: string }>().accessToken;
    vi.mocked(deletionJournal.isDeletionRequested).mockResolvedValue(true);

    const bearer = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const returning = await bootstrap('anon-key-journal-active');

    for (const response of [bearer, returning]) {
      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('USER_DELETED');
      expect(response.json()).not.toHaveProperty('accessToken');
    }
    const rows = await sql<{ identity_status: string }[]>`select identity_status from users`;
    expect(rows).toEqual([{ identity_status: 'active' }]);
    expect(provider.calls).toBe(1);
  });

  it('외부 저장소 장애는 bearer 와 bootstrap 에서 503 으로 전파된다', async () => {
    const first = await bootstrap('anon-key-journal-unavailable');
    const token = first.json<{ accessToken: string }>().accessToken;
    vi.mocked(deletionJournal.isDeletionRequested).mockRejectedValue(
      new AppError('DEPENDENCY_UNAVAILABLE'),
    );

    const bearer = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const returning = await bootstrap('anon-key-journal-unavailable');

    for (const response of [bearer, returning]) {
      expect(response.statusCode).toBe(503);
      expect(response.json<{ code: string }>().code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(response.json()).not.toHaveProperty('accessToken');
    }
  });

  it('차단 계정은 외부 저장소 장애보다 FORBIDDEN 을 우선한다', async () => {
    await bootstrap('anon-key-journal-blocked');
    await sql`update users set identity_status = 'blocked'`;
    const check = vi
      .mocked(deletionJournal.isDeletionRequested)
      .mockRejectedValue(new AppError('DEPENDENCY_UNAVAILABLE'));
    check.mockClear();

    const response = await bootstrap('anon-key-journal-blocked');

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
    expect(check).not.toHaveBeenCalled();
  });

  it('삭제 의도가 남은 예전 매핑은 재생성하지 않으며 매핑 폐기 후 새 UUID 재가입은 허용한다', async () => {
    const first = await bootstrap('anon-key-journal-rejoin');
    const oldToken = first.json<{ accessToken: string }>().accessToken;
    const [old] = await sql<{ id: string }[]>`select id from users`;
    await sql`update users set identity_status = 'deleted', deleted_at = now()`;
    vi.mocked(deletionJournal.isDeletionRequested).mockImplementation((id) =>
      Promise.resolve(id === old!.id),
    );

    const pending = await bootstrap('anon-key-journal-rejoin');
    expect(pending.statusCode).toBe(403);
    expect(pending.json<{ code: string }>().code).toBe('USER_DELETED');
    const [count] = await sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(count?.count).toBe('1');

    // 삭제 이행/재생이 기존 매핑을 폐기한 이후에만 새 ID 로 가입할 수 있다.
    await sql`update users set anon_key_fingerprint = 'revoked:' || id::text`;
    const rejoined = await bootstrap('anon-key-journal-rejoin');
    expect(rejoined.statusCode).toBe(201);
    const newToken = rejoined.json<{ accessToken: string }>().accessToken;
    const active = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json<{ userId: string }>().userId).not.toBe(old!.id);
    const deleted = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(deleted.statusCode).toBe(403);
    expect(deleted.json<{ code: string }>().code).toBe('USER_DELETED');
  });

  it.each(['deleted', 'tombstone'] as const)(
    '생성 충돌로 찾은 계정이 %s 이면 토큰을 발급하지 않는다',
    async (state) => {
      const anonKey = 'anon-key-journal-conflict';
      const current = buildFingerprintCandidates(anonKey)[0]!;
      vi.spyOn(provider, 'verifyAnonKey').mockImplementation(async () => {
        await sql`
          insert into users (anon_key_fingerprint, anon_key_fingerprint_version, identity_status, deleted_at)
          values (
            ${current.fingerprint}, ${current.version},
            ${state === 'deleted' ? 'deleted' : 'active'},
            ${state === 'deleted' ? new Date() : null}
          )
        `;
        vi.mocked(deletionJournal.isDeletionRequested).mockResolvedValue(state === 'tombstone');
        if (state === 'tombstone') {
          vi.mocked(deletionJournal.withLiveJournalSubject).mockRejectedValue(
            new AppError('USER_DELETED'),
          );
        }
        return { status: 'valid' };
      });

      const response = await bootstrap(anonKey);

      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('USER_DELETED');
      expect(response.json()).not.toHaveProperty('accessToken');
    },
  );

  it('최초 조회 이후 DB 상태가 삭제로 바뀌면 발급 직전 재확인으로 막는다', async () => {
    await bootstrap('anon-key-journal-status-race');
    vi.mocked(deletionJournal.isDeletionRequested).mockImplementationOnce(async () => {
      await sql`update users set identity_status = 'deleted', deleted_at = now()`;
      return false;
    });

    const response = await bootstrap('anon-key-journal-status-race');

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('USER_DELETED');
    expect(response.json()).not.toHaveProperty('accessToken');
  });

  it('최초 외부 조회 이후 삭제 의도가 생겨도 발급 직전에 다시 차단한다', async () => {
    await bootstrap('anon-key-journal-intent-race');
    vi.mocked(deletionJournal.withLiveJournalSubject).mockRejectedValue(
      new AppError('USER_DELETED'),
    );

    const response = await bootstrap('anon-key-journal-intent-race');

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('USER_DELETED');
    expect(response.json()).not.toHaveProperty('accessToken');
  });
});

describe('레이트리밋', () => {
  it('같은 식별키가 반복 호출되면 429 로 막는다', async () => {
    const anonKey = 'anon-key-rate-limited';
    let lastStatus = 0;

    // 내부 시작값: 식별키 기준 30회 / 10분
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const response = await bootstrap(anonKey);
      lastStatus = response.statusCode;
      if (lastStatus === 429) break;
    }

    expect(lastStatus).toBe(429);
  });
});
