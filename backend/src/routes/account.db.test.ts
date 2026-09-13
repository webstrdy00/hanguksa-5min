import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import type { IdentityProvider, VerificationOutcome } from '../auth/identity-provider.ts';
import {
  createTestClient,
  insertAdmin,
  insertQuestion,
  insertRevision,
  truncateAll,
} from '../db/test-helpers.ts';
import type { AppInstance } from '../http/types.ts';
import { startDeletionWorker } from '../jobs/deletion-worker.ts';
import { runPendingDeletionJobs } from '../services/deletion.ts';

/**
 * 계정 삭제 통합 테스트 (공통 04 §5, 09 §6, 하드게이트 P0).
 *
 * "삭제 요청이 DB → cache → push target → derived data → backup lifecycle 까지 추적됨"
 * 이 게이트를 실제 데이터로 확인한다.
 */
class AlwaysValidProvider implements IdentityProvider {
  readonly name = 'stub';
  verifyAnonKey(): Promise<VerificationOutcome> {
    return Promise.resolve({ status: 'valid' });
  }
}

let sql: postgres.Sql;
let app: AppInstance;
let token: string;
let reviewerId: string;

const ANON_KEY = 'anon-deletion-user';

function auth() {
  return { authorization: `Bearer ${token}` };
}

async function bootstrap(anonKey = ANON_KEY): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey },
  });
  return response.json<{ accessToken: string }>().accessToken;
}

/** 학습 기록을 실제로 만들어 지울 데이터를 확보한다. */
async function buildLearningHistory(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    const questionId = await insertQuestion(sql);
    await insertRevision(sql, { questionId, reviewerId, era: 'goryeo', topic: 'politics' });
  }

  const session = await app.inject({ method: 'POST', url: '/v1/study/today', headers: auth() });
  const body = session.json<{
    session: { id: string };
    items: { questionRevisionId: string }[];
  }>();

  for (const [index, item] of body.items.entries()) {
    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${body.session.id}/answer`,
      headers: auth(),
      payload: { questionRevisionId: item.questionRevisionId, selectedIndex: index === 0 ? 1 : 0 },
    });
  }

  await app.inject({
    method: 'POST',
    url: `/v1/sessions/${body.session.id}/complete`,
    headers: auth(),
  });

  // 신고와 알림 동의도 남겨둔다.
  await app.inject({
    method: 'POST',
    url: `/v1/questions/${body.items[0]!.questionRevisionId}/report`,
    headers: auth(),
    payload: { reason: 'ambiguous', detail: '사용자가 쓴 보충 설명' },
  });

  const [user] = await sql<{ id: string }[]>`select id from users limit 1`;
  await sql`
    insert into notification_consents (user_id, functional_agreed, functional_agreed_at)
    values (${user!.id}, true, now())
  `;
}

async function counts(): Promise<Record<string, string>> {
  const rows = await sql<{ table_name: string; count: string }[]>`
    select 'users' as table_name, count(*)::text as count from users
    union all select 'study_sessions', count(*)::text from study_sessions
    union all select 'study_session_items', count(*)::text from study_session_items
    union all select 'answers', count(*)::text from answers
    union all select 'user_question_state', count(*)::text from user_question_state
    union all select 'mastery', count(*)::text from mastery
    union all select 'notification_consents', count(*)::text from notification_consents
    union all select 'idempotency_keys', count(*)::text from idempotency_keys
    union all select 'question_reports', count(*)::text from question_reports
    union all select 'question_revisions', count(*)::text from question_revisions
    union all select 'deletion_jobs', count(*)::text from deletion_jobs
  `;
  return Object.fromEntries(rows.map((row) => [row.table_name, row.count]));
}

beforeAll(() => {
  sql = createTestClient();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await truncateAll(sql);
  app = await buildApp({ identityProvider: new AlwaysValidProvider() });
  await app.ready();

  reviewerId = await insertAdmin(sql, 'reviewer@example.test');
  await sql`
    insert into feature_flags (key, enabled, description)
    values ('daily_study', true, 'x'), ('question_report', true, 'y')
    on conflict (key) do nothing
  `;
  token = await bootstrap();
});

afterEach(async () => {
  await app.close();
});

describe('DELETE /v1/account', () => {
  it('인증 없이 삭제할 수 없다', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      payload: { confirm: '삭제' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('확인 문구 없이는 삭제되지 않는다', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: {},
    });

    expect(response.statusCode).toBe(400);

    const after = await counts();
    expect(after['users']).toBe('1');
  });

  it('삭제를 요청하면 job 이 생기고 즉시 식별키 매핑이 폐기된다', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json<{ jobId: string }>().jobId).toMatch(/^[0-9a-f-]{36}$/);

    const [user] = await sql<{ identity_status: string; anon_key_fingerprint: string }[]>`
      select identity_status, anon_key_fingerprint from users
    `;
    expect(user?.identity_status).toBe('deleted');
    expect(user?.anon_key_fingerprint).toContain('revoked:');
  });

  it('삭제 요청 후에는 기존 토큰으로 아무것도 할 수 없다', async () => {
    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth() });
    const study = await app.inject({ method: 'POST', url: '/v1/study/today', headers: auth() });

    expect(me.statusCode).toBe(403);
    expect(me.json<{ code: string }>().code).toBe('USER_DELETED');
    expect(study.statusCode).toBe(403);
  });

  it('같은 계정을 두 번 삭제 요청할 수 없다', async () => {
    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });

    // 토큰이 이미 무효라 403 이다. 계정 상태로 이중 요청이 막힌다.
    const again = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });

    expect(again.statusCode).toBe(403);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from deletion_jobs
    `;
    expect(row?.count).toBe('1');
  });

  it('삭제 후 같은 식별키로 다시 들어오면 새 계정이 만들어진다', async () => {
    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });

    const newToken = await bootstrap();
    expect(newToken).not.toBe(token);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(me.statusCode).toBe(200);
  });
});

describe('삭제 이행 배치 (하드게이트 P0: 데이터 맵 추적)', () => {
  it('서버 워커를 시작하면 대기 중인 삭제 요청이 실제로 처리된다', async () => {
    await buildLearningHistory();
    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });
    let failed = false;
    const stop = startDeletionWorker(
      () => runPendingDeletionJobs(),
      () => {
        failed = true;
      },
    );
    // 종료는 기동 직후 시작한 작업까지 기다린다.
    await stop();
    expect(failed).toBe(false);
    expect((await counts())['users']).toBe('0');
    const [job] = await sql`select status from deletion_jobs`;
    expect(job!.status).toBe('completed');
  });

  it('동시 워커는 같은 작업을 한 번만 완료한다', async () => {
    await buildLearningHistory();
    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });
    const results = await Promise.all([runPendingDeletionJobs(), runPendingDeletionJobs()]);
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect((await counts())['users']).toBe('0');
  });

  it.each(['failed', 'in_progress'])('%s 작업을 재기동 후 다시 처리한다', async (status) => {
    await buildLearningHistory();
    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });
    await sql`update deletion_jobs set status = ${status}, last_error = 'MOCK prior failure'`;
    expect(await runPendingDeletionJobs()).toBe(1);
    const [job] = await sql`select status, last_error from deletion_jobs`;
    expect(job!.status).toBe('completed');
    expect(job!.last_error).toBeNull();
    expect((await counts())['users']).toBe('0');
  });

  it('학습 데이터를 실제로 지우고 콘텐츠 이력은 남긴다', async () => {
    await buildLearningHistory();

    const before = await counts();
    expect(before['answers']).not.toBe('0');
    expect(before['mastery']).not.toBe('0');
    expect(before['notification_consents']).toBe('1');

    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });

    const processed = await runPendingDeletionJobs();
    expect(processed).toBe(1);

    const after = await counts();

    // 개인 학습 데이터는 사라진다.
    expect(after['users']).toBe('0');
    expect(after['study_sessions']).toBe('0');
    expect(after['study_session_items']).toBe('0');
    expect(after['answers']).toBe('0');
    expect(after['user_question_state']).toBe('0');
    expect(after['mastery']).toBe('0');
    expect(after['notification_consents']).toBe('0');
    expect(after['idempotency_keys']).toBe('0');

    // 콘텐츠와 삭제 증적은 남는다 (09 §6).
    expect(after['question_revisions']).toBe('6');
    expect(after['deletion_jobs']).toBe('1');
  });

  it('신고는 남기되 신고자와 작성 본문을 지운다', async () => {
    await buildLearningHistory();

    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });
    await runPendingDeletionJobs();

    const [report] = await sql<
      { reporter_user_id: string | null; detail: string | null; reason: string }[]
    >`select reporter_user_id, detail, reason from question_reports`;

    expect(report?.reason).toBe('ambiguous');
    expect(report?.reporter_user_id).toBeNull();
    // 사용자가 쓴 텍스트는 남기지 않는다.
    expect(report?.detail).toBeNull();
  });

  it('삭제 단계를 데이터 맵으로 기록한다', async () => {
    await buildLearningHistory();

    const requested = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });
    const jobId = requested.json<{ jobId: string }>().jobId;

    await runPendingDeletionJobs();

    const [job] = await sql<
      { status: string; steps: { step: string; status: string }[]; completed_at: Date | null }[]
    >`select status, steps, completed_at from deletion_jobs where id = ${jobId}`;

    expect(job?.status).toBe('completed');
    expect(job?.completed_at).not.toBeNull();

    const recorded = (job?.steps ?? []).map((step) => step.step);
    expect(recorded).toEqual([
      'operational_db',
      'cache',
      'push_target',
      'derived_data',
      'backup_lifecycle',
    ]);

    // 백업은 보관 주기가 지나야 소거되므로 예약 상태로 남는다.
    const backup = job?.steps.find((step) => step.step === 'backup_lifecycle');
    expect(backup?.status).toBe('scheduled');
  });

  it('배치를 여러 번 돌려도 안전하다 (멱등)', async () => {
    await buildLearningHistory();
    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });

    expect(await runPendingDeletionJobs()).toBe(1);
    // 두 번째 실행에는 처리할 작업이 없다.
    expect(await runPendingDeletionJobs()).toBe(0);

    const after = await counts();
    expect(after['users']).toBe('0');
    expect(after['deletion_jobs']).toBe('1');
  });

  it('다른 사용자의 데이터는 건드리지 않는다', async () => {
    await buildLearningHistory();

    // 두 번째 사용자가 학습한다.
    const otherToken = await bootstrap('anon-other-user');
    const otherSession = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherSession.statusCode).toBe(200);

    await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: auth(),
      payload: { confirm: '삭제' },
    });
    await runPendingDeletionJobs();

    const after = await counts();
    // 남은 사용자 1명과 그 세션은 그대로다.
    expect(after['users']).toBe('1');
    expect(after['study_sessions']).toBe('1');
  });
});
