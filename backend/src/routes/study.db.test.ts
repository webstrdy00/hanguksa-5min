import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import type { IdentityProvider, VerificationOutcome } from '../auth/identity-provider.ts';
import {
  createQuestionPool,
  createTestClient,
  insertAdmin,
  truncateAll,
} from '../db/test-helpers.ts';
import type { AppInstance } from '../http/types.ts';

/**
 * 오늘 세션 통합 테스트 (08 §2·§4, 09 §1~2).
 *
 * 서버 판정 · 멱등 · 동시성 · 날짜 경계 · void 처리를 실제 DB 로 검증한다.
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

interface SessionItem {
  slotIndex: number;
  slotSource: string;
  questionRevisionId: string;
  prompt: string;
  choices: string[];
  answered: boolean;
  voided: boolean;
  correctIndex?: number;
  explanation?: string;
}

interface SessionResponse {
  session: { id: string; studyDate: string; completedAt: string | null; score: number | null };
  items: SessionItem[];
}

function auth() {
  return { authorization: `Bearer ${token}` };
}

/**
 * 현재(가짜) 시각 기준으로 토큰을 다시 받는다.
 * 내부 토큰 TTL 이 30분이라 시계를 앞으로 돌리면 기존 토큰이 만료된다.
 */
async function refreshToken(): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey: 'anon-study-user' },
  });
  token = response.json<{ accessToken: string }>().accessToken;
}

async function startToday(): Promise<SessionResponse> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/study/today',
    headers: auth(),
  });
  return response.json<SessionResponse>();
}

async function answer(sessionId: string, revisionId: string, selectedIndex: number) {
  return await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/answer`,
    headers: auth(),
    payload: { questionRevisionId: revisionId, selectedIndex },
  });
}

async function complete(sessionId: string) {
  return await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/complete`,
    headers: auth(),
  });
}

/** 세트 전부에 정답(0) 또는 오답(1)을 제출한다. */
async function answerAll(session: SessionResponse, correct: boolean): Promise<void> {
  for (const item of session.items) {
    if (item.voided) continue;
    await answer(session.session.id, item.questionRevisionId, correct ? 0 : 1);
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
  app = await buildApp({ identityProvider: new AlwaysValidProvider() });
  await app.ready();

  reviewerId = await insertAdmin(sql, 'reviewer@example.test');
  await createQuestionPool(sql, reviewerId, 8);

  const bootstrap = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey: 'anon-study-user' },
  });
  token = bootstrap.json<{ accessToken: string }>().accessToken;
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe('POST /v1/study/today', () => {
  it('인증 없이 호출할 수 없다', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/study/today' });
    expect(response.statusCode).toBe(401);
  });

  it('5문항 세트를 만든다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<SessionResponse>();
    expect(body.items).toHaveLength(5);
    expect(body.items.map((item) => item.slotIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(body.session.completedAt).toBeNull();

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from study_session_items
    `;
    expect(row?.count).toBe('5');
  });

  it('풀기 전에는 정답과 해설을 내려보내지 않는다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: auth(),
    });

    const body = response.json<SessionResponse>();
    for (const item of body.items) {
      expect(item.correctIndex).toBeUndefined();
      expect(item.explanation).toBeUndefined();
      expect(item.choices).toHaveLength(5);
    }
    // 응답 본문 어디에도 해설이 없다.
    expect(response.body).not.toContain('정답 근거 해설');
  });

  it('같은 날 재요청하면 동일한 5개 revision 을 돌려준다 (08 §4)', async () => {
    const first = await startToday();
    const second = await startToday();

    expect(second.session.id).toBe(first.session.id);
    expect(second.items.map((item) => item.questionRevisionId)).toEqual(
      first.items.map((item) => item.questionRevisionId),
    );

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from study_sessions
    `;
    expect(row?.count).toBe('1');
  });

  it('동시에 두 번 요청해도 세션은 하나만 생긴다', async () => {
    const [first, second] = await Promise.all([startToday(), startToday()]);

    expect(first.session.id).toBe(second.session.id);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from study_sessions
    `;
    expect(row?.count).toBe('1');
  });

  it('published 문항이 5개 미만이면 반쪽 세션을 만들지 않는다', async () => {
    await sql`update question_revisions set status = 'retired' where status = 'published'`;
    // retired 는 출제 후보가 아니다.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/study/today',
      headers: auth(),
    });

    expect(response.statusCode).toBe(503);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from study_sessions
    `;
    expect(row?.count).toBe('0');
  });

  it('voided 문항은 새 세트에 배정되지 않는다 (08 §4)', async () => {
    const voided = await sql<{ id: string }[]>`
      update question_revisions set status = 'voided', status_reason = '사실 오류'
      where id = (select id from question_revisions where status = 'published' limit 1)
      returning id
    `;

    const session = await startToday();
    expect(session.items.map((item) => item.questionRevisionId)).not.toContain(voided[0]?.id);
  });
});

describe('POST /v1/sessions/:id/answer', () => {
  it('정답 여부를 서버가 판정하고 해설을 준다', async () => {
    const session = await startToday();
    const item = session.items[0]!;

    const correct = await answer(session.session.id, item.questionRevisionId, 0);
    expect(correct.statusCode).toBe(200);

    const body = correct.json<{ isCorrect: boolean; correctIndex: number; explanation: string }>();
    expect(body.isCorrect).toBe(true);
    expect(body.correctIndex).toBe(0);
    expect(body.explanation).toContain('해설');
  });

  it('오답도 서버가 판정한다', async () => {
    const session = await startToday();
    const item = session.items[0]!;

    const response = await answer(session.session.id, item.questionRevisionId, 3);
    expect(response.json<{ isCorrect: boolean }>().isCorrect).toBe(false);
  });

  it('연타로 같은 답을 다시 보내면 중복 행을 만들지 않는다', async () => {
    const session = await startToday();
    const item = session.items[0]!;

    const [first, second] = await Promise.all([
      answer(session.session.id, item.questionRevisionId, 0),
      answer(session.session.id, item.questionRevisionId, 0),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from answers
    `;
    expect(row?.count).toBe('1');
  });

  it('같은 문항에 다른 답을 보내면 422 다 (08 §1 answer immutable)', async () => {
    const session = await startToday();
    const item = session.items[0]!;

    await answer(session.session.id, item.questionRevisionId, 0);
    const changed = await answer(session.session.id, item.questionRevisionId, 2);

    expect(changed.statusCode).toBe(422);
    expect(changed.json<{ code: string }>().code).toBe('ANSWER_ALREADY_SUBMITTED');

    const [row] = await sql<{ selected_index: number }[]>`
      select selected_index from answers
    `;
    expect(row?.selected_index).toBe(0);
  });

  it('내 세션에 배정되지 않은 문항에는 답할 수 없다', async () => {
    const session = await startToday();
    const outside = await sql<{ id: string }[]>`
      select id from question_revisions
      where id not in (select question_revision_id from study_session_items)
      limit 1
    `;

    const response = await answer(session.session.id, outside[0]!.id, 0);
    expect(response.statusCode).toBe(404);
  });

  it('다른 사용자의 세션에는 답할 수 없다', async () => {
    const session = await startToday();

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload: { anonKey: 'anon-other-user' },
    });
    const otherToken = other.json<{ accessToken: string }>().accessToken;

    const response = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.session.id}/answer`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { questionRevisionId: session.items[0]!.questionRevisionId, selectedIndex: 0 },
    });

    expect(response.statusCode).toBe(404);
  });

  it('선택지 범위를 벗어나면 400 이다', async () => {
    const session = await startToday();
    const response = await answer(session.session.id, session.items[0]!.questionRevisionId, 9);
    expect(response.statusCode).toBe(400);
  });

  it('답한 문항은 재진입 시 결과가 함께 내려온다', async () => {
    const session = await startToday();
    await answer(session.session.id, session.items[0]!.questionRevisionId, 0);

    const again = await startToday();
    const answered = again.items.find((item) => item.answered);

    expect(answered?.correctIndex).toBe(0);
    expect(answered?.explanation).toBeTruthy();
  });
});

describe('POST /v1/sessions/:id/complete', () => {
  it('모든 문항을 풀어야 완료할 수 있다', async () => {
    const session = await startToday();
    await answer(session.session.id, session.items[0]!.questionRevisionId, 0);

    const tooEarly = await complete(session.session.id);
    expect(tooEarly.statusCode).toBe(409);
  });

  it('완료하면 서버가 점수를 계산하고 streak 를 시작한다', async () => {
    const session = await startToday();
    await answerAll(session, true);

    const response = await complete(session.session.id);
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      session: { score: number };
      streak: { days: number };
      validCount: number;
    }>();

    expect(body.session.score).toBe(5);
    expect(body.streak.days).toBe(1);
    expect(body.validCount).toBe(5);
  });

  it('오답이면 점수에서 빠진다', async () => {
    const session = await startToday();
    await answerAll(session, false);

    const body = (await complete(session.session.id)).json<{ session: { score: number } }>();
    expect(body.session.score).toBe(0);
  });

  it('완료 재요청은 오류가 아니라 같은 결과를 돌려준다', async () => {
    const session = await startToday();
    await answerAll(session, true);

    const first = await complete(session.session.id);
    const second = await complete(session.session.id);

    expect(second.statusCode).toBe(200);
    expect(second.json<{ alreadyCompleted: boolean }>().alreadyCompleted).toBe(true);
    expect(second.json<{ session: { score: number } }>().session.score).toBe(
      first.json<{ session: { score: number } }>().session.score,
    );

    const [row] = await sql<{ streak_days: number }[]>`select streak_days from users`;
    expect(row?.streak_days).toBe(1);
  });

  it('다른 사용자의 세션을 완료할 수 없다', async () => {
    const session = await startToday();
    await answerAll(session, true);

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload: { anonKey: 'anon-other-complete' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.session.id}/complete`,
      headers: { authorization: `Bearer ${other.json<{ accessToken: string }>().accessToken}` },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('void 문항 처리 (07 §9, 09 §2)', () => {
  it('세션 중 void 된 문항은 풀지 않아도 완료할 수 있고 점수에서 제외된다', async () => {
    const session = await startToday();

    // 첫 문항을 운영자가 void 처리했다고 가정한다.
    const voidedId = session.items[0]!.questionRevisionId;
    await sql`
      update question_revisions set status = 'voided', status_reason = '중대한 사실 오류'
      where id = ${voidedId}
    `;

    // 나머지 4개만 정답 처리한다.
    for (const item of session.items.slice(1)) {
      await answer(session.session.id, item.questionRevisionId, 0);
    }

    const response = await complete(session.session.id);
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      session: { score: number };
      streak: { days: number };
      validCount: number;
    }>();

    // 유효 문항은 4개이고 점수도 4점이다. 사용자의 실수로 취급하지 않는다.
    expect(body.validCount).toBe(4);
    expect(body.session.score).toBe(4);
    // 문항 오류로 streak 를 박탈하지 않는다.
    expect(body.streak.days).toBe(1);
  });
});

describe('날짜 경계 (09 §1)', () => {
  it('23:59 에 시작한 세션을 다음 날 00:30 에 완료하면 전날 streak 로 귀속된다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    // KST 2026-08-17 23:59
    vi.setSystemTime(new Date('2026-08-17T14:59:00Z'));
    await refreshToken();
    const session = await startToday();
    expect(session.session.studyDate).toBe('2026-08-17');
    await answerAll(session, true);

    // KST 2026-08-18 00:30 — 유예창 안
    vi.setSystemTime(new Date('2026-08-17T15:30:00Z'));
    await refreshToken();
    const response = await complete(session.session.id);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ streak: { lastStreakDate: string } }>().streak.lastStreakDate).toBe(
      '2026-08-17',
    );
  });

  it('01:00 KST 를 넘기면 전날 세션을 완료할 수 없다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2026-08-17T14:59:00Z'));
    await refreshToken();
    const session = await startToday();
    await answerAll(session, true);

    // KST 2026-08-18 01:00 — 유예창 종료
    vi.setSystemTime(new Date('2026-08-17T16:00:00Z'));
    await refreshToken();
    const response = await complete(session.session.id);

    expect(response.statusCode).toBe(409);
  });

  it('날짜가 바뀌면 새 세션이 만들어진다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    await refreshToken();
    const first = await startToday();

    vi.setSystemTime(new Date('2026-08-18T05:00:00Z'));
    await refreshToken();
    const second = await startToday();

    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.studyDate).toBe('2026-08-18');
  });

  it('연속으로 완료하면 streak 가 쌓이고 하루 건너뛰면 리셋된다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    await refreshToken();
    const day1 = await startToday();
    await answerAll(day1, true);
    expect((await complete(day1.session.id)).json<{ streak: { days: number } }>().streak.days).toBe(
      1,
    );

    vi.setSystemTime(new Date('2026-08-18T05:00:00Z'));
    await refreshToken();
    const day2 = await startToday();
    await answerAll(day2, true);
    expect((await complete(day2.session.id)).json<{ streak: { days: number } }>().streak.days).toBe(
      2,
    );

    // 8/19 을 건너뛰고 8/20 에 학습한다.
    vi.setSystemTime(new Date('2026-08-20T05:00:00Z'));
    await refreshToken();
    const day4 = await startToday();
    await answerAll(day4, true);
    expect((await complete(day4.session.id)).json<{ streak: { days: number } }>().streak.days).toBe(
      1,
    );
  });
});

describe('E2E P0: 문항 revision 수정 후에도 과거 세션 결과가 바뀌지 않는다 (08 §5)', () => {
  it('새 revision 을 발행해도 이미 푼 세션은 원래 내용과 점수를 유지한다', async () => {
    const session = await startToday();
    await answerAll(session, true);
    const completed = await complete(session.session.id);
    const originalScore = completed.json<{ session: { score: number } }>().session.score;

    const target = session.items[0]!;
    const questionRows = await sql<{ question_id: string }[]>`
      select question_id from question_revisions where id = ${target.questionRevisionId}
    `;
    const questionId = questionRows[0]!.question_id;

    // 운영자가 오타를 고쳐 새 revision 을 발행한다.
    await sql`
      update question_revisions set status = 'retired' where id = ${target.questionRevisionId}
    `;
    await sql`
      insert into question_revisions (
        question_id, revision, status, era, topic, ability, difficulty,
        prompt, choices, correct_index, explanation,
        source_refs, source_accessed_at, rights_type, reviewer_id, reviewed_at
      ) values (
        ${questionId}, 2, 'published', 'goryeo', 'politics', 'fact', 2,
        '고쳐진 문항입니다.', ${sql.json(['A', 'B', 'C', 'D', 'E'])}, 4, '고쳐진 해설입니다.',
        ${sql.json([{ title: '출처', url: 'https://example.test' }])},
        '2026-08-14', 'self_created', ${reviewerId}, now()
      )
    `;

    // 과거 세션을 다시 조회한다.
    const revisited = await startToday();

    expect(revisited.session.score).toBe(originalScore);
    const item = revisited.items.find(
      (entry) => entry.questionRevisionId === target.questionRevisionId,
    );
    expect(item?.prompt).toBe(target.prompt);
    expect(item?.prompt).not.toContain('고쳐진');
    expect(item?.correctIndex).toBe(0);
  });
});
