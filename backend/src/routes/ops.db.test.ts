import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { issueAdminToken } from '../auth/admin-token.ts';
import type { IdentityProvider, VerificationOutcome } from '../auth/identity-provider.ts';
import {
  createTestClient,
  insertAdmin,
  insertQuestion,
  insertRevision,
  truncateAll,
} from '../db/test-helpers.ts';
import type { AppInstance } from '../http/types.ts';
import { runPendingMasteryRecalcJobs } from '../services/mastery-jobs.ts';

/**
 * 오류 신고 · retire/void · 재계산 job · kill switch 통합 테스트 (07 §9, 09 §2, 공통 02 §7).
 *
 * E2E P0 (08 §5): 중대 오류 문항 void 후 progress 재계산에서 정답률이 정상 보정된다.
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
let adminToken: string;
let adminId: string;
let reviewerId: string;

interface SessionResponse {
  session: { id: string };
  items: { questionRevisionId: string }[];
}

function auth() {
  return { authorization: `Bearer ${token}` };
}
function adminAuth() {
  return { authorization: `Bearer ${adminToken}` };
}

async function refreshToken(): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey: 'anon-ops-user' },
  });
  token = response.json<{ accessToken: string }>().accessToken;
}

async function seedQuestions(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const questionId = await insertQuestion(sql);
    await insertRevision(sql, { questionId, reviewerId, era: 'goryeo', topic: 'politics' });
  }
}

async function startToday(): Promise<SessionResponse> {
  const response = await app.inject({ method: 'POST', url: '/v1/study/today', headers: auth() });
  return response.json<SessionResponse>();
}

async function answerAll(session: SessionResponse, selectedIndex: number): Promise<void> {
  for (const item of session.items) {
    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.session.id}/answer`,
      headers: auth(),
      payload: { questionRevisionId: item.questionRevisionId, selectedIndex },
    });
  }
}

async function report(revisionId: string, reason = 'wrong_answer', detail?: string) {
  return await app.inject({
    method: 'POST',
    url: `/v1/questions/${revisionId}/report`,
    headers: auth(),
    payload: detail == null ? { reason } : { reason, detail },
  });
}

async function setStatus(revisionId: string, status: string, statusReason?: string) {
  return await app.inject({
    method: 'PATCH',
    url: `/admin/v1/revisions/${revisionId}/status`,
    headers: adminAuth(),
    payload: statusReason == null ? { status } : { status, statusReason },
  });
}

async function seedFlags(): Promise<void> {
  await sql`
    insert into feature_flags (key, enabled, description) values
      ('daily_study', true, '오늘 5문제 학습 세션'),
      ('question_report', true, '오류 제보 접수'),
      ('push_notification', false, '기능성 알림 발송')
    on conflict (key) do nothing
  `;
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
  adminId = await insertAdmin(sql, 'admin@example.test');
  await sql`update admin_users set role = 'admin' where id = ${adminId}`;
  adminToken = (await issueAdminToken(adminId, 'admin')).token;

  await seedFlags();
  await refreshToken();
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/questions/:id/report', () => {
  beforeEach(async () => {
    await seedQuestions(6);
  });

  it('인증 없이 신고할 수 없다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/questions/00000000-0000-4000-8000-000000000000/report',
      payload: { reason: 'wrong_answer' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('오류를 제보하면 접수된다', async () => {
    const session = await startToday();
    const response = await report(
      session.items[0]!.questionRevisionId,
      'ambiguous',
      '보기가 애매해요',
    );

    expect(response.statusCode).toBe(201);
    expect(response.json<{ merged: boolean }>().merged).toBe(false);

    const [row] = await sql<{ reason: string; status: string; detail: string }[]>`
      select reason, status, detail from question_reports
    `;
    expect(row?.reason).toBe('ambiguous');
    expect(row?.status).toBe('open');
    expect(row?.detail).toBe('보기가 애매해요');
  });

  it('사용자가 고른 답은 저장하지 않는다 (08 §2)', async () => {
    const session = await startToday();
    await report(session.items[0]!.questionRevisionId);

    const [row] = await sql<{ dump: string }[]>`
      select row_to_json(question_reports)::text as dump from question_reports limit 1
    `;
    expect(row?.dump).not.toContain('selected_index');
  });

  it('정의되지 않은 사유는 400 이다', async () => {
    const session = await startToday();
    const response = await report(session.items[0]!.questionRevisionId, 'because_i_said_so');
    expect(response.statusCode).toBe(400);
  });

  it('없는 문항은 404 다', async () => {
    const response = await report('00000000-0000-4000-8000-000000000000');
    expect(response.statusCode).toBe(404);
  });

  it('같은 문항을 다시 신고하면 기존 접수에 합친다 (공통 04 §3)', async () => {
    const session = await startToday();
    const revisionId = session.items[0]!.questionRevisionId;

    const first = await report(revisionId);
    const second = await report(revisionId);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ merged: boolean }>().merged).toBe(true);
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from question_reports
    `;
    expect(row?.count).toBe('1');
  });
});

describe('관리자 신고 처리', () => {
  beforeEach(async () => {
    await seedQuestions(6);
  });

  it('신고 큐를 조회하고 상태를 바꾼다', async () => {
    const session = await startToday();
    await report(session.items[0]!.questionRevisionId);

    const list = await app.inject({
      method: 'GET',
      url: '/admin/v1/reports?status=open',
      headers: adminAuth(),
    });
    expect(list.statusCode).toBe(200);

    const reportId = list.json<{ items: { id: string }[] }>().items[0]!.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/v1/reports/${reportId}`,
      headers: adminAuth(),
      payload: { status: 'resolved' },
    });

    expect(patched.statusCode).toBe(200);

    const [row] = await sql<{ status: string; resolved_at: Date | null }[]>`
      select status, resolved_at from question_reports
    `;
    expect(row?.status).toBe('resolved');
    expect(row?.resolved_at).not.toBeNull();

    const [audit] = await sql<{ action: string }[]>`
      select action from admin_audit_logs where action = 'resolve_report'
    `;
    expect(audit?.action).toBe('resolve_report');
  });

  it('이미 처리된 신고는 다시 바꿀 수 없다', async () => {
    const session = await startToday();
    await report(session.items[0]!.questionRevisionId);

    const list = await app.inject({
      method: 'GET',
      url: '/admin/v1/reports',
      headers: adminAuth(),
    });
    const reportId = list.json<{ items: { id: string }[] }>().items[0]!.id;

    await app.inject({
      method: 'PATCH',
      url: `/admin/v1/reports/${reportId}`,
      headers: adminAuth(),
      payload: { status: 'rejected' },
    });

    const again = await app.inject({
      method: 'PATCH',
      url: `/admin/v1/reports/${reportId}`,
      headers: adminAuth(),
      payload: { status: 'resolved' },
    });

    expect(again.statusCode).toBe(409);
  });

  it('사용자 토큰으로 신고 큐를 볼 수 없다', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/reports',
      headers: auth(),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('E2E P0: void 후 정답률 보정 (08 §5)', () => {
  it('신고 → void → 재계산 job 으로 통계가 보정되고 streak 는 유지된다', async () => {
    await seedQuestions(6);

    const session = await startToday();
    // 전부 오답으로 제출한다.
    await answerAll(session, 3);
    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.session.id}/complete`,
      headers: auth(),
    });

    const before = await app.inject({ method: 'GET', url: '/v1/progress', headers: auth() });
    const beforeBody = before.json<{
      eras: { era: string; seenCount: number; accuracyPercent: number | null }[];
      streak: { days: number };
    }>();
    expect(beforeBody.eras.find((era) => era.era === 'goryeo')?.seenCount).toBe(5);
    expect(beforeBody.eras.find((era) => era.era === 'goryeo')?.accuracyPercent).toBe(0);
    expect(beforeBody.streak.days).toBe(1);

    // 사용자가 오류를 신고하고 운영자가 void 처리한다.
    const badRevision = session.items[0]!.questionRevisionId;
    await report(badRevision, 'wrong_answer');
    const voided = await setStatus(badRevision, 'voided', '정답이 틀렸습니다');
    expect(voided.statusCode).toBe(200);

    // void 트랜잭션에서 재계산 작업이 생겼다.
    const [job] = await sql<{ status: string; reason: string }[]>`
      select status, reason from mastery_recalc_jobs
    `;
    expect(job?.status).toBe('pending');
    expect(job?.reason).toBe('question_voided');

    // 배치가 처리한다.
    const results = await runPendingMasteryRecalcJobs();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('completed');
    expect(results[0]?.processedUsers).toBe(1);

    const after = await app.inject({ method: 'GET', url: '/v1/progress', headers: auth() });
    const afterBody = after.json<{
      eras: { era: string; seenCount: number; accuracyPercent: number | null }[];
      streak: { days: number };
    }>();

    // void 문항이 집계에서 빠졌다.
    expect(afterBody.eras.find((era) => era.era === 'goryeo')?.seenCount).toBe(4);
    // 문항 오류로 streak 를 박탈하지 않는다 (09 §2).
    expect(afterBody.streak.days).toBe(1);

    const [session_] = await sql<{ score: number; completed_at: Date }[]>`
      select score, completed_at from study_sessions
    `;
    expect(session_?.completed_at).not.toBeNull();
  });

  it('재계산 작업은 멱등하다', async () => {
    await seedQuestions(6);
    const session = await startToday();
    await answerAll(session, 0);

    await setStatus(session.items[0]!.questionRevisionId, 'voided', '사실 오류');

    await runPendingMasteryRecalcJobs();
    const first = await app.inject({ method: 'GET', url: '/v1/progress', headers: auth() });

    // 같은 작업을 다시 만들어 돌려도 결과가 같다.
    await sql`update mastery_recalc_jobs set status = 'pending', processed_users = 0`;
    await runPendingMasteryRecalcJobs();
    const second = await app.inject({ method: 'GET', url: '/v1/progress', headers: auth() });

    expect(second.json<{ eras: unknown[] }>().eras).toEqual(first.json<{ eras: unknown[] }>().eras);
  });

  it('void 된 문항은 새 세션에 배정되지 않는다', async () => {
    await seedQuestions(6);
    const session = await startToday();
    const badRevision = session.items[0]!.questionRevisionId;

    await setStatus(badRevision, 'voided', '사실 오류');

    // 세션을 지우면 문항도 cascade 로 함께 지워진다.
    // 문항만 먼저 지우면 "세션당 5문항" deferred 제약에 걸린다.
    await sql`delete from study_sessions`;

    const next = await startToday();
    expect(next.items.map((item) => item.questionRevisionId)).not.toContain(badRevision);
  });

  it('작업 진행 상황을 기록한다', async () => {
    await seedQuestions(6);
    const session = await startToday();
    await answerAll(session, 0);
    await setStatus(session.items[0]!.questionRevisionId, 'voided', '사실 오류');

    await runPendingMasteryRecalcJobs();

    const [job] = await sql<
      { status: string; total_users: number; processed_users: number; completed_at: Date | null }[]
    >`select status, total_users, processed_users, completed_at from mastery_recalc_jobs`;

    expect(job?.status).toBe('completed');
    expect(job?.total_users).toBe(1);
    expect(job?.processed_users).toBe(1);
    expect(job?.completed_at).not.toBeNull();
  });
});

describe('정정 안내 (07 §9)', () => {
  it('관리자가 발행하면 사용자가 볼 수 있다', async () => {
    await seedQuestions(6);
    const [question] = await sql<{ id: string }[]>`select id from questions limit 1`;

    const created = await app.inject({
      method: 'POST',
      url: `/admin/v1/questions/${question!.id}/correction`,
      headers: adminAuth(),
      payload: { noticeType: 'void', message: '해당 문항에 오류가 있어 집계에서 제외했어요.' },
    });

    expect(created.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/v1/corrections', headers: auth() });
    const body = list.json<{ corrections: { noticeType: string; message: string }[] }>();

    expect(body.corrections).toHaveLength(1);
    expect(body.corrections[0]?.noticeType).toBe('void');

    const [audit] = await sql<{ action: string }[]>`
      select action from admin_audit_logs where action = 'publish_correction'
    `;
    expect(audit?.action).toBe('publish_correction');
  });

  it('reviewer 는 정정 안내를 발행할 수 없다', async () => {
    await seedQuestions(6);
    const [question] = await sql<{ id: string }[]>`select id from questions limit 1`;
    const reviewerToken = (await issueAdminToken(reviewerId, 'reviewer')).token;

    const response = await app.inject({
      method: 'POST',
      url: `/admin/v1/questions/${question!.id}/correction`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { noticeType: 'correction', message: '수정했습니다' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('kill switch (공통 02 §7)', () => {
  it('플래그를 끄면 재배포 없이 학습이 중단된다', async () => {
    await seedQuestions(6);

    const before = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: auth(),
    });
    expect(before.statusCode).toBe(200);

    const toggled = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/feature-flags/daily_study',
      headers: adminAuth(),
      payload: { enabled: false },
    });
    expect(toggled.statusCode).toBe(200);

    const after = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: auth(),
    });

    expect(after.statusCode).toBe(503);
    expect(after.json<{ retryable: boolean }>().retryable).toBe(true);
  });

  it('오류 제보도 끌 수 있다', async () => {
    await seedQuestions(6);
    const session = await startToday();

    await app.inject({
      method: 'PATCH',
      url: '/admin/v1/feature-flags/question_report',
      headers: adminAuth(),
      payload: { enabled: false },
    });

    const response = await report(session.items[0]!.questionRevisionId);
    expect(response.statusCode).toBe(503);
  });

  it('플래그 변경은 감사 로그에 남는다', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/admin/v1/feature-flags/daily_study',
      headers: adminAuth(),
      payload: { enabled: false },
    });

    const [audit] = await sql<{ action: string; detail: string }[]>`
      select action, detail::text as detail from admin_audit_logs where action = 'toggle_feature_flag'
    `;
    expect(audit?.action).toBe('toggle_feature_flag');
    expect(audit?.detail).toContain('daily_study');
  });

  it('없는 플래그는 404 다', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/feature-flags/not_a_flag',
      headers: adminAuth(),
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(404);
  });

  it('사용자는 플래그 상태를 조회만 할 수 있다', async () => {
    const read = await app.inject({ method: 'GET', url: '/v1/feature-flags', headers: auth() });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ flags: unknown[] }>().flags.length).toBeGreaterThan(0);

    const write = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/feature-flags/daily_study',
      headers: auth(),
      payload: { enabled: false },
    });
    expect(write.statusCode).toBe(401);
  });
});
