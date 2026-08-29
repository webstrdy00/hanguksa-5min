import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import { issueAdminToken } from '../auth/admin-token.ts';
import type { IdentityProvider, VerificationOutcome } from '../auth/identity-provider.ts';
import { issueAccessToken } from '../auth/token.ts';
import {
  createTestClient,
  insertAdmin,
  insertQuestion,
  insertRevision,
  truncateAll,
} from '../db/test-helpers.ts';
import type { AppInstance } from '../http/types.ts';

/**
 * 실패 경로 E2E.
 *
 * happy path 만 테스트하면 실제 사고를 못 잡는다.
 * 여기서는 네트워크/타임아웃/중복/권한/토큰/경계 상황을 다룬다.
 *
 * ※ 이 앱에는 invite / challenge / pair / reveal 개념이 없다.
 *   해당 시나리오는 만들지 않는다 (AGENTS.md §1, 00_패키지_사용안내 §3).
 */
class ControllableProvider implements IdentityProvider {
  readonly name = 'stub';
  outcome: VerificationOutcome = { status: 'valid' };
  calls = 0;

  verifyAnonKey(): Promise<VerificationOutcome> {
    this.calls += 1;
    return Promise.resolve(this.outcome);
  }
}

let sql: postgres.Sql;
let app: AppInstance;
let provider: ControllableProvider;
let reviewerId: string;

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function bootstrap(anonKey: string) {
  return await app.inject({ method: 'POST', url: '/v1/auth/bootstrap', payload: { anonKey } });
}

async function tokenFor(anonKey: string): Promise<string> {
  return (await bootstrap(anonKey)).json<{ accessToken: string }>().accessToken;
}

async function seedQuestions(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const questionId = await insertQuestion(sql);
    await insertRevision(sql, { questionId, reviewerId, era: 'goryeo', topic: 'politics' });
  }
}

beforeAll(() => {
  sql = createTestClient();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await truncateAll(sql);
  provider = new ControllableProvider();
  app = await buildApp({ identityProvider: provider });
  await app.ready();

  reviewerId = await insertAdmin(sql, 'reviewer@example.test');
  await sql`
    insert into feature_flags (key, enabled, description)
    values ('daily_study', true, 'x'), ('question_report', true, 'y')
    on conflict (key) do nothing
  `;
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe('최초 사용자 / 재방문 사용자', () => {
  it('최초 사용자는 검증을 거치고, 재방문은 검증 없이 통과한다', async () => {
    // Given/When: 처음 보는 식별키
    const first = await bootstrap('returning-user');
    expect(first.statusCode).toBe(201);
    expect(provider.calls).toBe(1);

    // When: 같은 사용자가 다시 들어온다
    const second = await bootstrap('returning-user');

    // Then: 검증 API 를 다시 부르지 않는다 (앱당 3000 QPM 보호)
    expect(second.statusCode).toBe(200);
    expect(provider.calls).toBe(1);
  });
});

describe('앱인토스 식별키 검증 API 장애', () => {
  it('검증 API 가 죽으면 503 이고 계정을 만들지 않는다', async () => {
    provider.outcome = { status: 'unavailable', reason: 'http_timeout' };

    const response = await bootstrap('provider-down');

    expect(response.statusCode).toBe(503);
    expect(response.json<{ retryable: boolean }>().retryable).toBe(true);

    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(row?.count).toBe('0');
  });

  it('검증 API 한도 초과도 사용자를 막지 않고 재시도로 안내한다', async () => {
    provider.outcome = {
      status: 'unavailable',
      reason: 'provider_rate_limited',
      retryAfterSeconds: 10,
    };

    const response = await bootstrap('provider-limited');

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
  });

  it('무효한 키는 401 이고 계정이 생기지 않는다', async () => {
    provider.outcome = { status: 'invalid', reason: 'not_verified' };

    const response = await bootstrap('invalid-key');

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('INVALID_USER_KEY');

    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(row?.count).toBe('0');
  });

  it('장애가 복구되면 정상 가입된다', async () => {
    provider.outcome = { status: 'unavailable', reason: 'transport_error' };
    expect((await bootstrap('recovering')).statusCode).toBe(503);

    provider.outcome = { status: 'valid' };
    expect((await bootstrap('recovering')).statusCode).toBe(201);
  });
});

describe('만료된 토큰 / 위조 토큰', () => {
  it('만료된 토큰은 401 이다', async () => {
    await bootstrap('expired-token-user');
    const [user] = await sql<{ id: string }[]>`select id from users`;
    const expired = await issueAccessToken(user!.id, new Date(Date.now() - 7_200_000));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(expired.token),
    });

    expect(response.statusCode).toBe(401);
  });

  it('서명을 위조한 토큰은 401 이다', async () => {
    const token = await tokenFor('forged-token-user');
    const parts = token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;

    const response = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(forged) });
    expect(response.statusCode).toBe(401);
  });

  it('토큰이 유효해도 계정이 차단되면 403 이다', async () => {
    const token = await tokenFor('blocked-user');
    await sql`update users set identity_status = 'blocked'`;

    const response = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
  });
});

describe('권한 없는 사용자 접근', () => {
  it('남의 세션에는 답할 수 없다', async () => {
    await seedQuestions(8);

    const ownerToken = await tokenFor('session-owner');
    const owner = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(ownerToken),
    });
    const ownerBody = owner.json<{
      session: { id: string };
      items: { questionRevisionId: string }[];
    }>();

    const attackerToken = await tokenFor('attacker');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${ownerBody.session.id}/answer`,
      headers: bearer(attackerToken),
      payload: {
        questionRevisionId: ownerBody.items[0]!.questionRevisionId,
        selectedIndex: 0,
      },
    });

    // 존재 자체를 알려주지 않는다 (404, 403 아님)
    expect(response.statusCode).toBe(404);
  });

  it('남의 세션을 완료 처리할 수 없다', async () => {
    await seedQuestions(8);
    const ownerToken = await tokenFor('complete-owner');
    const owner = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(ownerToken),
    });
    const sessionId = owner.json<{ session: { id: string } }>().session.id;

    const attackerToken = await tokenFor('complete-attacker');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/complete`,
      headers: bearer(attackerToken),
    });

    expect(response.statusCode).toBe(404);
  });

  it('사용자 토큰으로 관리자 API 를 통과할 수 없다', async () => {
    const token = await tokenFor('not-an-admin');

    for (const url of ['/admin/v1/exams', '/admin/v1/questions', '/admin/v1/reports']) {
      const response = await app.inject({ method: 'GET', url, headers: bearer(token) });
      expect(response.statusCode).toBe(401);
    }
  });

  it('reviewer 는 발행과 정정 안내를 할 수 없다', async () => {
    const reviewerToken = (await issueAdminToken(reviewerId, 'reviewer')).token;
    const questionId = await insertQuestion(sql);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/v1/questions/${questionId}/correction`,
      headers: bearer(reviewerToken),
      payload: { noticeType: 'correction', message: '수정했습니다' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('이미 완료된 상태에서 재요청', () => {
  it('완료한 세션의 미답 문항에는 여전히 답할 수 있다 (유예창 안)', async () => {
    // void 로 유효 문항이 줄어든 세션도 완료되므로, 완료 후 상태를 확인한다.
    await seedQuestions(8);
    const token = await tokenFor('already-complete');
    const session = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });
    const body = session.json<{
      session: { id: string };
      items: { questionRevisionId: string }[];
    }>();

    for (const item of body.items) {
      await app.inject({
        method: 'POST',
        url: `/v1/sessions/${body.session.id}/answer`,
        headers: bearer(token),
        payload: { questionRevisionId: item.questionRevisionId, selectedIndex: 0 },
      });
    }
    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${body.session.id}/complete`,
      headers: bearer(token),
    });

    // 같은 답을 다시 보내면 기존 판정이 재생된다 (오류가 아니다)
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${body.session.id}/answer`,
      headers: bearer(token),
      payload: { questionRevisionId: body.items[0]!.questionRevisionId, selectedIndex: 0 },
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ replayed: boolean }>().replayed).toBe(true);
  });

  it('다 풀지 않고 완료를 시도하면 409 다', async () => {
    await seedQuestions(8);
    const token = await tokenFor('incomplete-user');
    const session = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });
    const body = session.json<{
      session: { id: string };
      items: { questionRevisionId: string }[];
    }>();

    // 3문항만 푼다
    for (const item of body.items.slice(0, 3)) {
      await app.inject({
        method: 'POST',
        url: `/v1/sessions/${body.session.id}/answer`,
        headers: bearer(token),
        payload: { questionRevisionId: item.questionRevisionId, selectedIndex: 0 },
      });
    }

    const response = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${body.session.id}/complete`,
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(409);
  });

  it('제출한 답을 다른 값으로 바꿀 수 없다', async () => {
    await seedQuestions(8);
    const token = await tokenFor('immutable-answer');
    const session = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });
    const body = session.json<{
      session: { id: string };
      items: { questionRevisionId: string }[];
    }>();
    const target = body.items[0]!.questionRevisionId;

    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${body.session.id}/answer`,
      headers: bearer(token),
      payload: { questionRevisionId: target, selectedIndex: 1 },
    });

    const changed = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${body.session.id}/answer`,
      headers: bearer(token),
      payload: { questionRevisionId: target, selectedIndex: 4 },
    });

    expect(changed.statusCode).toBe(422);
    expect(changed.json<{ code: string }>().code).toBe('ANSWER_ALREADY_SUBMITTED');

    const [row] = await sql<{ selected_index: number }[]>`
      select selected_index from answers where question_revision_id = ${target}
    `;
    expect(row?.selected_index).toBe(1);
  });
});

describe('DB transaction rollback', () => {
  it('세션 생성이 실패하면 세션도 문항도 남지 않는다', async () => {
    // Given: 문항이 4개뿐이라 5문항 세트를 만들 수 없다
    await seedQuestions(4);
    const token = await tokenFor('rollback-user');

    // When: 세션을 시작한다
    const response = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });

    // Then: 반쪽 세션을 만들지 않고 503 으로 안전 실패한다
    expect(response.statusCode).toBe(503);

    const rows = await sql<{ sessions: string; items: string }[]>`
      select
        (select count(*)::text from study_sessions) as sessions,
        (select count(*)::text from study_session_items) as items
    `;
    expect(rows[0]?.sessions).toBe('0');
    expect(rows[0]?.items).toBe('0');
  });
});

describe('Backend 장애 / 기능 중단', () => {
  it('kill switch 를 켜면 학습이 중단되고 재시도로 안내한다', async () => {
    await seedQuestions(8);
    const token = await tokenFor('killswitch-user');

    await sql`update feature_flags set enabled = false where key = 'daily_study'`;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ retryable: boolean }>().retryable).toBe(true);
  });

  it('알 수 없는 경로도 공통 오류 envelope 로 응답한다', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ code: string; requestId: string; retryable: boolean }>();
    expect(body.code).toBe('NOT_FOUND');
    expect(body.requestId).not.toBe('');
    expect(body.retryable).toBe(false);
  });
});

describe('잘못된 입력 / 잘못된 경로 파라미터', () => {
  it('uuid 가 아닌 세션 id 는 404 다', async () => {
    const token = await tokenFor('bad-param-user');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions/not-a-uuid/complete',
      headers: bearer(token),
    });

    expect([400, 404]).toContain(response.statusCode);
  });

  it('오류 details 에 사용자 입력 원문을 담지 않는다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload: { anonKey: 'x' },
    });

    expect(response.statusCode).toBe(400);
    // 입력값이 그대로 응답에 실려 나가면 안 된다
    expect(response.body).not.toContain('"x"');
  });

  it('본문이 없는 POST 도 400 이 되지 않는다', async () => {
    await seedQuestions(8);
    const token = await tokenFor('empty-body-user');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: '',
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('레이트리밋', () => {
  it('오류 제보를 반복하면 429 로 막는다', async () => {
    await seedQuestions(8);
    const token = await tokenFor('report-spam');
    const session = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });
    const items = session.json<{ items: { questionRevisionId: string }[] }>().items;

    // 서로 다른 문항으로 신고해야 "중복 합치기"가 아니라 실제 건수가 쌓인다.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const target = items[attempt % items.length]!.questionRevisionId;
      const response = await app.inject({
        method: 'POST',
        url: `/v1/questions/${target}/report`,
        headers: bearer(token),
        payload: { reason: 'other', detail: `제보 ${attempt}` },
      });
      lastStatus = response.statusCode;
      if (lastStatus === 429) break;
    }

    expect(lastStatus).toBe(429);
  });
});

describe('앱 종료 후 재진입 / 날짜 경계', () => {
  it('앱을 껐다 켜도 같은 세션과 진행 상황이 복원된다', async () => {
    await seedQuestions(8);
    const token = await tokenFor('reentry-user');

    const first = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });
    const body = first.json<{
      session: { id: string };
      items: { questionRevisionId: string }[];
    }>();

    // 2문항만 풀고 앱을 끈다
    for (const item of body.items.slice(0, 2)) {
      await app.inject({
        method: 'POST',
        url: `/v1/sessions/${body.session.id}/answer`,
        headers: bearer(token),
        payload: { questionRevisionId: item.questionRevisionId, selectedIndex: 0 },
      });
    }

    // 재진입 (토큰도 새로 받는다 = reload 후 bootstrap 재수행)
    const newToken = await tokenFor('reentry-user');
    const resumed = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(newToken),
    });
    const resumedBody = resumed.json<{
      session: { id: string };
      items: { answered: boolean; questionRevisionId: string }[];
    }>();

    // 같은 세션, 같은 문항, 답한 기록이 그대로다
    expect(resumedBody.session.id).toBe(body.session.id);
    expect(resumedBody.items.filter((item) => item.answered)).toHaveLength(2);
    expect(resumedBody.items.map((item) => item.questionRevisionId)).toEqual(
      body.items.map((item) => item.questionRevisionId),
    );
  });

  it('날짜가 바뀌면 새 세션이 만들어진다', async () => {
    await seedQuestions(8);
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    let token = await tokenFor('date-boundary-user');
    const day1 = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });

    vi.setSystemTime(new Date('2026-08-18T05:00:00Z'));
    token = await tokenFor('date-boundary-user');
    const day2 = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });

    const id1 = day1.json<{ session: { id: string; studyDate: string } }>().session;
    const id2 = day2.json<{ session: { id: string; studyDate: string } }>().session;

    expect(id2.id).not.toBe(id1.id);
    expect(id1.studyDate).toBe('2026-08-17');
    expect(id2.studyDate).toBe('2026-08-18');
  });

  it('UTC 로는 같은 날이어도 KST 기준으로 날짜가 갈린다', async () => {
    await seedQuestions(8);
    vi.useFakeTimers({ toFake: ['Date'] });

    // UTC 8/17 14:00 = KST 8/17 23:00
    vi.setSystemTime(new Date('2026-08-17T14:00:00Z'));
    let token = await tokenFor('kst-boundary-user');
    const before = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });
    expect(before.json<{ session: { studyDate: string } }>().session.studyDate).toBe('2026-08-17');

    // UTC 8/17 15:00 = KST 8/18 00:00 (같은 UTC 날짜, 다른 KST 날짜)
    vi.setSystemTime(new Date('2026-08-17T15:00:00Z'));
    token = await tokenFor('kst-boundary-user');
    const after = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });
    expect(after.json<{ session: { studyDate: string } }>().session.studyDate).toBe('2026-08-18');
  });
});

describe('개인정보 노출 방지', () => {
  it('어떤 응답에도 anonKey 원문이 실리지 않는다', async () => {
    const anonKey = 'super-secret-anon-key-value';
    await seedQuestions(8);

    const boot = await bootstrap(anonKey);
    expect(boot.body).not.toContain(anonKey);

    const token = boot.json<{ accessToken: string }>().accessToken;
    for (const url of ['/v1/me', '/v1/exams', '/v1/progress', '/v1/wrong-notes']) {
      const response = await app.inject({ method: 'GET', url, headers: bearer(token) });
      expect(response.body).not.toContain(anonKey);
    }
  });

  it('풀기 전 문항 응답에 정답과 해설이 없다', async () => {
    await seedQuestions(8);
    const token = await tokenFor('no-leak-user');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: bearer(token),
    });

    const items = response.json<{ items: Record<string, unknown>[] }>().items;
    for (const item of items) {
      expect(item['correctIndex']).toBeUndefined();
      expect(item['explanation']).toBeUndefined();
    }
  });
});
