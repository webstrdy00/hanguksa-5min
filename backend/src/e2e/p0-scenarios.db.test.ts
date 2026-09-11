import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { runPendingDeletionJobs } from '../services/deletion.ts';
import { runPendingMasteryRecalcJobs } from '../services/mastery-jobs.ts';

/**
 * 08 §5 / AGENTS.md §11 필수 E2E P0.
 *
 * 도메인별 테스트에도 일부 시나리오가 있지만, 여기서는 **출시 게이트 기준으로**
 * 8개 항목을 한 파일에서 사용자 여정 순서대로 검증한다.
 * 이 파일이 통과하지 못하면 "완료"가 아니다.
 *
 * 각 시나리오는 Given / When / Then 으로 읽히게 작성한다.
 */
class StubProvider implements IdentityProvider {
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
let provider: StubProvider;
let reviewerId: string;
let adminToken: string;

interface SessionBody {
  session: { id: string; studyDate: string; completedAt: string | null; score: number | null };
  items: {
    slotIndex: number;
    slotSource: string;
    questionRevisionId: string;
    era: string;
    prompt: string;
    voided: boolean;
    answered: boolean;
  }[];
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function bootstrap(anonKey: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey },
  });
  return response.json<{ accessToken: string }>().accessToken;
}

/** published 문항을 원하는 수만큼 만든다. */
async function seedQuestions(count: number, era = 'goryeo'): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const questionId = await insertQuestion(sql);
    const revisionId = await insertRevision(sql, {
      questionId,
      reviewerId,
      era,
      topic: 'politics',
    });
    ids.push(revisionId);
  }
  return ids;
}

async function seedExam(round: number, examDate: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into exam_schedules (type, round, exam_date, status, source_url, source_verified_at)
    values ('advanced', ${round}, ${examDate}, 'scheduled', 'https://www.historyexam.go.kr/', now())
    returning id
  `;
  return rows[0]!.id;
}

function kstDatePlus(days: number): string {
  return new Date(Date.now() + 9 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

async function startSession(token: string): Promise<SessionBody> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/study/today',
    headers: bearer(token),
  });
  return response.json<SessionBody>();
}

async function answer(token: string, sessionId: string, revisionId: string, selectedIndex: number) {
  return await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/answer`,
    headers: bearer(token),
    payload: { questionRevisionId: revisionId, selectedIndex },
  });
}

async function complete(token: string, sessionId: string) {
  return await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/complete`,
    headers: bearer(token),
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
  provider = new StubProvider();
  app = await buildApp({ identityProvider: provider });
  await app.ready();

  reviewerId = await insertAdmin(sql, 'reviewer@example.test');
  const adminId = await insertAdmin(sql, 'admin@example.test');
  await sql`update admin_users set role = 'admin' where id = ${adminId}`;
  adminToken = (await issueAdminToken(adminId, 'admin')).token;

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

describe('P0-1. 신규 사용자: 목표 선택 → 5문제 → 완료 → 다음 날 복습 후보', () => {
  it('첫 학습을 마치면 틀린 문항이 다음 날 복습 슬롯으로 돌아온다', async () => {
    // Given: 출제 가능한 문항과 시험 일정이 있다
    await seedQuestions(8);
    const examId = await seedExam(80, kstDatePlus(60));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-17T05:00:00Z')); // KST 14:00

    let token = await bootstrap('p0-1-user');

    // When: 목표를 고르고
    const goal = await app.inject({
      method: 'PATCH',
      url: '/v1/profile/goal',
      headers: bearer(token),
      payload: { targetGrade: 2, targetExamId: examId },
    });
    expect(goal.statusCode).toBe(200);

    // 5문제를 풀고 완료한다 (첫 문항만 오답)
    const session = await startSession(token);
    expect(session.items).toHaveLength(5);

    for (const [index, item] of session.items.entries()) {
      await answer(token, session.session.id, item.questionRevisionId, index === 0 ? 1 : 0);
    }
    const completed = await complete(token, session.session.id);

    // Then: 완료되고 streak 가 시작된다
    expect(completed.statusCode).toBe(200);
    expect(completed.json<{ session: { score: number } }>().session.score).toBe(4);
    expect(completed.json<{ streak: { days: number } }>().streak.days).toBe(1);

    // And: 다음 날 세션에 그 문항이 복습으로 배정된다
    vi.setSystemTime(new Date('2026-08-18T05:00:00Z'));
    token = await bootstrap('p0-1-user');
    const nextDay = await startSession(token);

    const reviewSlot = nextDay.items.find((item) => item.slotSource === 'review');
    expect(reviewSlot?.questionRevisionId).toBe(session.items[0]!.questionRevisionId);
  });
});

describe('P0-2. 오답 → 1일 → 3일 → 7일 복습 간격 전이', () => {
  it('정답을 이어가면 간격이 늘고 마지막에 복습 큐에서 졸업한다', async () => {
    // Given: 8/17 에 문항을 틀렸다
    await seedQuestions(8);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));

    let token = await bootstrap('p0-2-user');
    const first = await startSession(token);
    const target = first.items[0]!.questionRevisionId;
    await answer(token, first.session.id, target, 1);

    const readState = async () => {
      const rows = await sql<{ interval_step: number; review_due_at: Date | null }[]>`
        select s.interval_step, s.review_due_at
        from user_question_state s
        join question_revisions r on r.question_id = s.canonical_question_id
        where r.id = ${target}
      `;
      return rows[0];
    };

    // Then: 1일 뒤(KST 8/18 00:00)로 예약된다
    expect((await readState())?.interval_step).toBe(1);
    expect((await readState())?.review_due_at?.toISOString()).toBe('2026-08-17T15:00:00.000Z');

    // When: 8/18 정답 → 3일 뒤
    vi.setSystemTime(new Date('2026-08-18T05:00:00Z'));
    token = await bootstrap('p0-2-user');
    let session = await startSession(token);
    await answer(token, session.session.id, target, 0);
    expect((await readState())?.interval_step).toBe(2);
    expect((await readState())?.review_due_at?.toISOString()).toBe('2026-08-20T15:00:00.000Z');

    // When: 8/21 정답 → 7일 뒤
    vi.setSystemTime(new Date('2026-08-21T05:00:00Z'));
    token = await bootstrap('p0-2-user');
    session = await startSession(token);
    await answer(token, session.session.id, target, 0);
    expect((await readState())?.interval_step).toBe(3);
    expect((await readState())?.review_due_at?.toISOString()).toBe('2026-08-27T15:00:00.000Z');

    // When: 8/28 정답 → 졸업
    vi.setSystemTime(new Date('2026-08-28T05:00:00Z'));
    token = await bootstrap('p0-2-user');
    session = await startSession(token);
    await answer(token, session.session.id, target, 0);

    // Then: 복습 큐에서 빠진다
    expect((await readState())?.review_due_at).toBeNull();
  });
});

describe('P0-3. 문항 revision 수정 후에도 과거 세션 결과 불변', () => {
  it('새 revision 을 발행해도 이미 푼 세션의 내용과 점수가 그대로다', async () => {
    // Given: 사용자가 5문제를 풀었다
    await seedQuestions(8);
    const token = await bootstrap('p0-3-user');
    const session = await startSession(token);

    for (const item of session.items) {
      await answer(token, session.session.id, item.questionRevisionId, 0);
    }
    await complete(token, session.session.id);

    const targetRevision = session.items[0]!.questionRevisionId;
    const originalPrompt = session.items[0]!.prompt;

    // When: 운영자가 그 문항의 새 revision 을 발행한다
    const [question] = await sql<{ question_id: string }[]>`
      select question_id from question_revisions where id = ${targetRevision}
    `;

    const created = await app.inject({
      method: 'POST',
      url: `/admin/v1/questions/${question!.question_id}/revisions`,
      headers: { ...bearer(adminToken), 'idempotency-key': 'p0-3-rev' },
      payload: {
        era: 'goryeo',
        topic: 'politics',
        ability: 'fact',
        difficulty: 2,
        prompt: '완전히 새로 고친 문항입니다',
        choices: ['새보기1', '새보기2', '새보기3', '새보기4', '새보기5'],
        correctIndex: 4,
        explanation: '새 해설입니다',
        sourceRefs: [{ title: '출처', url: 'https://example.test' }],
        sourceAccessedAt: '2026-08-14',
        rightsType: 'self_created',
      },
    });
    const newRevisionId = created.json<{ revisionId: string }>().revisionId;

    await app.inject({
      method: 'PATCH',
      url: `/admin/v1/revisions/${newRevisionId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'review' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/admin/v1/revisions/${newRevisionId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'approved' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/admin/v1/revisions/${newRevisionId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'published' },
    });

    // Then: 과거 세션은 원래 revision 을 그대로 보여준다
    const replayed = await startSession(token);
    const sameItem = replayed.items.find((item) => item.questionRevisionId === targetRevision);

    expect(sameItem).toBeDefined();
    expect(sameItem?.prompt).toBe(originalPrompt);
    expect(sameItem?.prompt).not.toContain('완전히 새로 고친');
    expect(replayed.session.score).toBe(5);
  });
});

describe('P0-4. void 후 progress 재계산에서 정답률 보정', () => {
  it('오류 문항을 제외해 통계를 고치되 학습 완료와 streak 는 유지한다', async () => {
    // Given: 5문제를 전부 틀려 정답률이 0% 다
    await seedQuestions(8);
    const token = await bootstrap('p0-4-user');
    const session = await startSession(token);

    for (const item of session.items) {
      await answer(token, session.session.id, item.questionRevisionId, 3);
    }
    await complete(token, session.session.id);

    const before = await app.inject({ method: 'GET', url: '/v1/progress', headers: bearer(token) });
    const beforeEra = before
      .json<{ eras: { era: string; seenCount: number; accuracyPercent: number | null }[] }>()
      .eras.find((era) => era.era === 'goryeo');
    expect(beforeEra?.seenCount).toBe(5);
    expect(beforeEra?.accuracyPercent).toBe(0);

    // When: 사용자가 신고하고 운영자가 void 처리한 뒤 배치가 돈다
    await app.inject({
      method: 'POST',
      url: `/v1/questions/${session.items[0]!.questionRevisionId}/report`,
      headers: bearer(token),
      payload: { reason: 'wrong_answer' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/admin/v1/revisions/${session.items[0]!.questionRevisionId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'voided', statusReason: '정답 오류' },
    });

    const results = await runPendingMasteryRecalcJobs();
    expect(results[0]?.status).toBe('completed');

    // Then: 집계에서만 빠지고 완료 기록은 남는다
    const after = await app.inject({ method: 'GET', url: '/v1/progress', headers: bearer(token) });
    const afterBody = after.json<{
      eras: { era: string; seenCount: number }[];
      streak: { days: number };
    }>();

    expect(afterBody.eras.find((era) => era.era === 'goryeo')?.seenCount).toBe(4);
    // 09 §2: 문항 오류로 사용자의 streak 를 제거하지 않는다
    expect(afterBody.streak.days).toBe(1);

    const [row] = await sql<{ completed_at: Date | null; score: number }[]>`
      select completed_at, score from study_sessions
    `;
    expect(row?.completed_at).not.toBeNull();
  });
});

describe('P0-5. exam_schedules 변경만으로 앱 재배포 없이 D-day 갱신', () => {
  it('서버 데이터만 고쳐도 사용자 화면의 D-day 가 바뀐다', async () => {
    // Given: 사용자가 60일 남은 회차를 목표로 잡았다
    const examId = await seedExam(80, kstDatePlus(60));
    const token = await bootstrap('p0-5-user');

    await app.inject({
      method: 'PATCH',
      url: '/v1/profile/goal',
      headers: bearer(token),
      payload: { targetGrade: 1, targetExamId: examId },
    });

    const before = await app.inject({ method: 'GET', url: '/v1/exams', headers: bearer(token) });
    expect(before.json<{ goal: { exam: { dday: number } } }>().goal.exam.dday).toBe(60);

    // When: 운영자가 일정을 앞당긴다 (배포 없음)
    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/v1/exams/${examId}`,
      headers: bearer(adminToken),
      payload: { examDate: kstDatePlus(20), changeReason: '공식 공지 일정 변경' },
    });
    expect(patched.statusCode).toBe(200);

    // Then: 같은 클라이언트가 즉시 새 D-day 를 받는다
    const after = await app.inject({ method: 'GET', url: '/v1/exams', headers: bearer(token) });
    expect(after.json<{ goal: { exam: { dday: number } } }>().goal.exam.dday).toBe(20);

    // And: 변경 이력이 남는다
    const [audit] = await sql<{ change_reason: string }[]>`
      select change_reason from exam_schedule_audits
    `;
    expect(audit?.change_reason).toBe('공식 공지 일정 변경');
  });
});

describe('P0-7. 23:59 시작 → 01:00 KST 전 완료 시 전날 streak 귀속', () => {
  it('자정을 넘겨 완료해도 전날 학습으로 기록된다', async () => {
    // Given: KST 8/17 23:59 에 세션을 시작했다
    await seedQuestions(8);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-17T14:59:00Z'));

    let token = await bootstrap('p0-7-user');
    const session = await startSession(token);
    expect(session.session.studyDate).toBe('2026-08-17');

    for (const item of session.items) {
      await answer(token, session.session.id, item.questionRevisionId, 0);
    }

    // When: KST 8/18 00:30 에 완료한다 (유예창 안)
    vi.setSystemTime(new Date('2026-08-17T15:30:00Z'));
    token = await bootstrap('p0-7-user');
    const completed = await complete(token, session.session.id);

    // Then: 전날 학습으로 귀속된다
    expect(completed.statusCode).toBe(200);
    const body = completed.json<{
      session: { studyDate: string };
      streak: { days: number; lastStreakDate: string };
    }>();
    expect(body.session.studyDate).toBe('2026-08-17');
    expect(body.streak.lastStreakDate).toBe('2026-08-17');
  });

  it('01:00 KST 를 넘기면 전날 세션을 완료할 수 없다', async () => {
    await seedQuestions(8);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-17T14:59:00Z'));

    let token = await bootstrap('p0-7-late');
    const session = await startSession(token);
    for (const item of session.items) {
      await answer(token, session.session.id, item.questionRevisionId, 0);
    }

    // When: KST 8/18 01:00 (유예창 종료)
    vi.setSystemTime(new Date('2026-08-17T16:00:00Z'));
    token = await bootstrap('p0-7-late');
    const late = await complete(token, session.session.id);

    // Then: 상태 충돌로 거부된다
    expect(late.statusCode).toBe(409);
  });
});

describe('P0-8. 답안 연타 / 네트워크 재연결에서 중복 응답 없음', () => {
  it('같은 답을 동시에 여러 번 보내도 answers 는 한 행이다', async () => {
    // Given: 세션이 시작됐다
    await seedQuestions(8);
    const token = await bootstrap('p0-8-user');
    const session = await startSession(token);
    const target = session.items[0]!.questionRevisionId;

    // When: 같은 답을 5번 동시에 보낸다 (버튼 연타 + 재전송)
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => answer(token, session.session.id, target, 1)),
    );

    // Then: 전부 성공 응답이고 저장은 한 번만 된다
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from answers where question_revision_id = ${target}
    `;
    expect(row?.count).toBe('1');
  });

  it('세션 생성을 동시에 요청해도 하루 한 세션이다', async () => {
    await seedQuestions(8);
    const token = await bootstrap('p0-8-session');

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({ method: 'POST', url: '/v1/study/today', headers: bearer(token) }),
      ),
    );

    const sessionIds = new Set(
      responses.map((response) => response.json<SessionBody>().session.id),
    );
    expect(sessionIds.size).toBe(1);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from study_sessions
    `;
    expect(row?.count).toBe('1');
  });

  it('완료를 두 번 눌러도 점수와 streak 가 중복 반영되지 않는다', async () => {
    await seedQuestions(8);
    const token = await bootstrap('p0-8-complete');
    const session = await startSession(token);

    for (const item of session.items) {
      await answer(token, session.session.id, item.questionRevisionId, 0);
    }

    const first = await complete(token, session.session.id);
    const second = await complete(token, session.session.id);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ alreadyCompleted: boolean }>().alreadyCompleted).toBe(true);
    expect(second.json<{ streak: { days: number } }>().streak.days).toBe(1);
  });
});

describe('P0-20. 개인정보 삭제 요청 (하드게이트)', () => {
  it('삭제 요청 후 학습 데이터가 실제로 사라지고 콘텐츠는 남는다', async () => {
    // Given: 학습 기록이 있는 사용자
    await seedQuestions(8);
    const token = await bootstrap('p0-20-user');
    const session = await startSession(token);
    for (const item of session.items) {
      await answer(token, session.session.id, item.questionRevisionId, 0);
    }
    await complete(token, session.session.id);

    // When: 삭제를 요청하고 배치가 돈다
    const requested = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: bearer(token),
      payload: { confirm: '삭제' },
    });
    expect(requested.statusCode).toBe(202);

    // 요청 즉시 기존 토큰이 무효화된다
    const blocked = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(blocked.statusCode).toBe(403);

    await runPendingDeletionJobs();

    // Then: 개인 데이터는 사라지고 콘텐츠와 증적은 남는다
    const rows = await sql<{ table_name: string; count: string }[]>`
      select 'users' as table_name, count(*)::text as count from users
      union all select 'answers', count(*)::text from answers
      union all select 'study_sessions', count(*)::text from study_sessions
      union all select 'mastery', count(*)::text from mastery
      union all select 'question_revisions', count(*)::text from question_revisions
      union all select 'deletion_jobs', count(*)::text from deletion_jobs
    `;
    const counts = Object.fromEntries(rows.map((row) => [row.table_name, row.count]));

    expect(counts['users']).toBe('0');
    expect(counts['answers']).toBe('0');
    expect(counts['study_sessions']).toBe('0');
    expect(counts['mastery']).toBe('0');
    expect(counts['question_revisions']).toBe('8');
    expect(counts['deletion_jobs']).toBe('1');
  });
});
