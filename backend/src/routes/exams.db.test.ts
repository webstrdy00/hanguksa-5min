import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { issueAdminToken } from '../auth/admin-token.ts';
import type { IdentityProvider, VerificationOutcome } from '../auth/identity-provider.ts';
import { createTestClient, insertAdmin, truncateAll } from '../db/test-helpers.ts';
import type { AppInstance } from '../http/types.ts';

/**
 * 시험 일정 도메인 통합 테스트.
 *
 * E2E P0 (08 §5): exam_schedules 데이터 변경만으로 앱 재배포 없이 D-day 가 갱신된다.
 */
class AlwaysValidProvider implements IdentityProvider {
  readonly name = 'stub';
  verifyAnonKey(): Promise<VerificationOutcome> {
    return Promise.resolve({ status: 'valid' });
  }
}

let sql: postgres.Sql;
let app: AppInstance;

/** KST 로 오늘부터 N일 뒤 날짜 문자열. 테스트가 날짜에 의존하지 않게 한다. */
function kstDatePlus(days: number): string {
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000 + days * 86_400_000);
  return kstNow.toISOString().slice(0, 10);
}

async function userToken(anonKey: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey },
  });
  return response.json<{ accessToken: string }>().accessToken;
}

async function adminToken(role = 'admin', email = 'admin@example.test'): Promise<string> {
  const adminId = await insertAdmin(sql, email);
  await sql`update admin_users set role = ${role} where id = ${adminId}`;
  const issued = await issueAdminToken(adminId, role);
  return issued.token;
}

async function seedExam(round: number, date: string, status = 'scheduled'): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into exam_schedules (type, round, exam_date, status, source_url, source_verified_at)
    values ('advanced', ${round}, ${date}, ${status}, 'https://www.historyexam.go.kr/', now())
    returning id
  `;
  return rows[0]!.id;
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
});

afterEach(async () => {
  await app.close();
});

describe('GET /v1/exams', () => {
  it('인증 없이 호출할 수 없다', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/exams' });
    expect(response.statusCode).toBe(401);
  });

  it('다가오는 회차를 D-day 와 함께 돌려준다', async () => {
    await seedExam(80, kstDatePlus(62));
    await seedExam(81, kstDatePlus(104));
    await seedExam(79, kstDatePlus(-7));

    const token = await userToken('anon-exams-list');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/exams',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      today: string;
      exams: { round: number; dday: number; selectable: boolean }[];
      goal: { needsReselection: boolean };
    }>();

    expect(body.exams.map((exam) => exam.round)).toEqual([80, 81]);
    expect(body.exams[0]?.dday).toBe(62);
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 목표를 아직 고르지 않았으면 선택이 필요하다.
    expect(body.goal.needsReselection).toBe(true);
  });
});

describe('PATCH /v1/profile/goal', () => {
  it('목표 급수와 회차를 바꾼다', async () => {
    const examId = await seedExam(80, kstDatePlus(62));
    const token = await userToken('anon-goal-set');

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/profile/goal',
      headers: { authorization: `Bearer ${token}` },
      payload: { targetGrade: 2, targetExamId: examId },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      goal: {
        targetGrade: number;
        exam: { round: number; dday: number };
        needsReselection: boolean;
      };
    }>();

    expect(body.goal.targetGrade).toBe(2);
    expect(body.goal.exam.round).toBe(80);
    expect(body.goal.exam.dday).toBe(62);
    expect(body.goal.needsReselection).toBe(false);
  });

  it('없는 회차는 404 다', async () => {
    const token = await userToken('anon-goal-404');

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/profile/goal',
      headers: { authorization: `Bearer ${token}` },
      payload: { targetExamId: '00000000-0000-4000-8000-000000000000' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('지난 회차는 목표로 고를 수 없다 (409)', async () => {
    const examId = await seedExam(79, kstDatePlus(-1));
    const token = await userToken('anon-goal-past');

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/profile/goal',
      headers: { authorization: `Bearer ${token}` },
      payload: { targetExamId: examId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('STATE_CONFLICT');
  });

  it('급수 범위를 벗어나면 400 이다', async () => {
    const token = await userToken('anon-goal-grade');

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/profile/goal',
      headers: { authorization: `Bearer ${token}` },
      payload: { targetGrade: 4 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('목표 회차가 지나면 다시 고르라고 알려준다 (08 §4)', async () => {
    const examId = await seedExam(80, kstDatePlus(5));
    const token = await userToken('anon-goal-expire');

    await app.inject({
      method: 'PATCH',
      url: '/v1/profile/goal',
      headers: { authorization: `Bearer ${token}` },
      payload: { targetExamId: examId },
    });

    // 운영자가 일정을 취소했다고 가정한다.
    await sql`update exam_schedules set status = 'cancelled' where id = ${examId}`;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/exams',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.json<{ goal: { needsReselection: boolean } }>().goal.needsReselection).toBe(
      true,
    );
  });
});

describe('관리자 인증 경계 (공통 04 §2)', () => {
  it('토큰 없이 관리자 API 에 접근할 수 없다', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/v1/exams' });
    expect(response.statusCode).toBe(401);
  });

  it('사용자 토큰으로는 관리자 API 를 통과할 수 없다', async () => {
    const token = await userToken('anon-admin-attempt');

    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/exams',
      headers: { authorization: `Bearer ${token}` },
    });

    // 관리자 키로 검증되지 않는 토큰이므로 신원 확인 실패다.
    expect(response.statusCode).toBe(401);
  });

  it('관리자 토큰으로는 사용자 API 를 통과할 수 없다', async () => {
    const token = await adminToken();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('reviewer 역할은 일정을 바꿀 수 없다 (403)', async () => {
    const token = await adminToken('reviewer', 'reviewer-only@example.test');

    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/exams',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'key-reviewer' },
      payload: {
        type: 'advanced',
        round: 82,
        examDate: kstDatePlus(120),
        sourceUrl: 'https://www.historyexam.go.kr/',
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('비활성화된 관리자는 즉시 차단된다', async () => {
    const token = await adminToken('admin', 'disabled@example.test');
    await sql`update admin_users set status = 'disabled'`;

    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/exams',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('POST /admin/v1/exams', () => {
  it('회차를 등록하고 감사 로그를 남긴다', async () => {
    const token = await adminToken();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/exams',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'create-80' },
      payload: {
        type: 'advanced',
        round: 80,
        examDate: kstDatePlus(62),
        sourceUrl: 'https://www.historyexam.go.kr/',
      },
    });

    expect(response.statusCode).toBe(201);

    const [schedule] = await sql<{ count: string }[]>`
      select count(*)::text as count from exam_schedules
    `;
    expect(schedule?.count).toBe('1');

    const [audit] = await sql<{ count: string }[]>`
      select count(*)::text as count from exam_schedule_audits
    `;
    expect(audit?.count).toBe('1');

    const [adminAudit] = await sql<{ action: string }[]>`
      select action from admin_audit_logs
    `;
    expect(adminAudit?.action).toBe('update_exam_schedule');
  });

  it('Idempotency-Key 없이 등록할 수 없다', async () => {
    const token = await adminToken();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/exams',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: 'advanced',
        round: 80,
        examDate: kstDatePlus(62),
        sourceUrl: 'https://www.historyexam.go.kr/',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('같은 Idempotency-Key 로 재전송하면 중복 생성하지 않는다', async () => {
    const token = await adminToken();
    const payload = {
      type: 'advanced',
      round: 80,
      examDate: kstDatePlus(62),
      sourceUrl: 'https://www.historyexam.go.kr/',
    };
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'retry-80' };

    const first = await app.inject({ method: 'POST', url: '/admin/v1/exams', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/admin/v1/exams', headers, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from exam_schedules
    `;
    expect(row?.count).toBe('1');
  });

  it('같은 키로 다른 내용을 보내면 거부한다', async () => {
    const token = await adminToken();
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'same-key' };

    await app.inject({
      method: 'POST',
      url: '/admin/v1/exams',
      headers,
      payload: {
        type: 'advanced',
        round: 80,
        examDate: kstDatePlus(62),
        sourceUrl: 'https://www.historyexam.go.kr/',
      },
    });

    const conflict = await app.inject({
      method: 'POST',
      url: '/admin/v1/exams',
      headers,
      payload: {
        type: 'advanced',
        round: 81,
        examDate: kstDatePlus(104),
        sourceUrl: 'https://www.historyexam.go.kr/',
      },
    });

    expect(conflict.statusCode).toBe(422);
  });

  it('이미 있는 회차는 409 이고 중복 생성하지 않는다', async () => {
    await seedExam(80, kstDatePlus(62));
    const token = await adminToken();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/exams',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'dup-80' },
      payload: {
        type: 'advanced',
        round: 80,
        examDate: kstDatePlus(63),
        sourceUrl: 'https://www.historyexam.go.kr/',
      },
    });

    expect(response.statusCode).toBe(409);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from exam_schedules
    `;
    expect(row?.count).toBe('1');
  });

  it('실패한 요청은 같은 키로 다시 시도할 수 있다', async () => {
    const token = await adminToken();
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'retry-after-fail' };

    const invalid = await app.inject({
      method: 'POST',
      url: '/admin/v1/exams',
      headers,
      payload: { type: 'advanced', round: -1, examDate: 'nope', sourceUrl: 'not-a-url' },
    });
    expect(invalid.statusCode).toBe(400);

    const [remaining] = await sql<{ count: string }[]>`
      select count(*)::text as count from idempotency_keys
    `;
    expect(remaining?.count).toBe('0');
  });
});

describe('PATCH /admin/v1/exams/:id — E2E P0: 재배포 없이 D-day 갱신', () => {
  it('일정 데이터만 바꿔도 사용자 화면의 D-day 가 바뀐다', async () => {
    const examId = await seedExam(80, kstDatePlus(62));
    const token = await userToken('anon-dday');

    await app.inject({
      method: 'PATCH',
      url: '/v1/profile/goal',
      headers: { authorization: `Bearer ${token}` },
      payload: { targetGrade: 1, targetExamId: examId },
    });

    const before = await app.inject({
      method: 'GET',
      url: '/v1/exams',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.json<{ goal: { exam: { dday: number } } }>().goal.exam.dday).toBe(62);

    // 운영자가 서버 데이터만 수정한다. 앱 배포는 없다.
    const admin = await adminToken();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/v1/exams/${examId}`,
      headers: { authorization: `Bearer ${admin}` },
      payload: {
        examDate: kstDatePlus(30),
        changeReason: '공식 공지에서 시험일 변경 확인',
        sourceUrl: 'https://www.history.go.kr/',
      },
    });
    expect(patched.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/v1/exams',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(after.json<{ goal: { exam: { dday: number } } }>().goal.exam.dday).toBe(30);
  });

  it('변경 전후 상태를 감사 로그에 남긴다', async () => {
    const examId = await seedExam(80, kstDatePlus(62));
    const admin = await adminToken();

    await app.inject({
      method: 'PATCH',
      url: `/admin/v1/exams/${examId}`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { status: 'changed', changeReason: '공식 사이트 일정 변경 공지' },
    });

    const [audit] = await sql<
      { change_reason: string; before_state: { status: string }; after_state: { status: string } }[]
    >`select change_reason, before_state, after_state from exam_schedule_audits`;

    expect(audit?.change_reason).toBe('공식 사이트 일정 변경 공지');
    expect(audit?.before_state.status).toBe('scheduled');
    expect(audit?.after_state.status).toBe('changed');
  });

  it('변경 사유 없이 일정을 바꿀 수 없다', async () => {
    const examId = await seedExam(80, kstDatePlus(62));
    const admin = await adminToken();

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/v1/exams/${examId}`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { status: 'cancelled' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('없는 회차는 404 다', async () => {
    const admin = await adminToken();

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/exams/00000000-0000-4000-8000-000000000000',
      headers: { authorization: `Bearer ${admin}` },
      payload: { status: 'cancelled', changeReason: '테스트' },
    });

    expect(response.statusCode).toBe(404);
  });
});
