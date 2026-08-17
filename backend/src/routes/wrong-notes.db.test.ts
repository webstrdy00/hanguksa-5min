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
 * 복습 큐 · 오답노트 통합 테스트 (07 §2, 03 §3).
 *
 * E2E P0 (08 §5):
 *  - 신규 사용자: 5문제 완료 → 다음 날 복습 후보 생성
 *  - 오답 → 1일 후 정답 → 3일 후 정답 → 7일 review_due 상태 전이
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
  questionRevisionId: string;
  slotSource: string;
  voided: boolean;
}
interface SessionResponse {
  session: { id: string; studyDate: string };
  items: SessionItem[];
}

function auth() {
  return { authorization: `Bearer ${token}` };
}

async function refreshToken(): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey: 'anon-review-user' },
  });
  token = response.json<{ accessToken: string }>().accessToken;
}

async function startToday(): Promise<SessionResponse> {
  const response = await app.inject({ method: 'POST', url: '/v1/study/today', headers: auth() });
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

/** 첫 문항만 틀리고 나머지는 맞힌 뒤 완료한다. */
async function playSession(wrongFirst: boolean): Promise<SessionResponse> {
  const session = await startToday();

  for (const [index, item] of session.items.entries()) {
    if (item.voided) continue;
    const wrong = wrongFirst && index === 0;
    await answer(session.session.id, item.questionRevisionId, wrong ? 1 : 0);
  }

  await app.inject({
    method: 'POST',
    url: `/v1/sessions/${session.session.id}/complete`,
    headers: auth(),
  });

  return session;
}

async function stateOf(revisionId: string) {
  const rows = await sql<
    { interval_step: number; review_due_at: Date | null; last_result: string }[]
  >`
    select s.interval_step, s.review_due_at, s.last_result
    from user_question_state s
    join question_revisions r on r.question_id = s.canonical_question_id
    where r.id = ${revisionId}
  `;
  return rows[0];
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
  await refreshToken();
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe('답안 → 복습 상태 갱신 (07 §2)', () => {
  it('틀린 문항은 다음 날 복습 후보가 된다 (E2E P0)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    await refreshToken();

    const session = await playSession(true);
    const wrongItem = session.items[0]!;

    const state = await stateOf(wrongItem.questionRevisionId);
    expect(state?.interval_step).toBe(1);
    expect(state?.last_result).toBe('wrong');
    // KST 2026-08-18 00:00 = 2026-08-17T15:00Z
    expect(state?.review_due_at?.toISOString()).toBe('2026-08-17T15:00:00.000Z');

    // 다음 날 세션에 복습 슬롯으로 다시 나온다.
    vi.setSystemTime(new Date('2026-08-18T05:00:00Z'));
    await refreshToken();
    const nextDay = await startToday();

    const reviewSlot = nextDay.items.find((item) => item.slotSource === 'review');
    expect(reviewSlot?.questionRevisionId).toBe(wrongItem.questionRevisionId);
  });

  it('맞힌 문항은 복습 큐에 들어가지 않는다', async () => {
    const session = await playSession(false);
    const state = await stateOf(session.items[0]!.questionRevisionId);

    expect(state?.interval_step).toBe(0);
    expect(state?.review_due_at).toBeNull();
    expect(state?.last_result).toBe('correct');
  });

  it('답안과 복습 상태가 같은 트랜잭션에서 기록된다', async () => {
    const session = await startToday();
    await answer(session.session.id, session.items[0]!.questionRevisionId, 1);

    const [answerRow] = await sql<{ count: string }[]>`
      select count(*)::text as count from answers
    `;
    const [stateRow] = await sql<{ count: string }[]>`
      select count(*)::text as count from user_question_state
    `;

    expect(answerRow?.count).toBe('1');
    expect(stateRow?.count).toBe('1');
  });

  it('연타로 같은 답을 다시 보내도 복습 상태가 중복 갱신되지 않는다', async () => {
    const session = await startToday();
    const item = session.items[0]!;

    await Promise.all([
      answer(session.session.id, item.questionRevisionId, 1),
      answer(session.session.id, item.questionRevisionId, 1),
    ]);

    const [row] = await sql<{ wrong_count: number }[]>`
      select wrong_count from user_question_state
    `;
    expect(row?.wrong_count).toBe(1);
  });
});

describe('E2E P0: 오답 → 1일 → 3일 → 7일 상태 전이 (08 §5)', () => {
  it('정답을 이어가면 간격이 1 → 3 → 7 로 늘고 마지막에 졸업한다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    // 8/17 오답
    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    await refreshToken();
    const first = await playSession(true);
    const target = first.items[0]!.questionRevisionId;

    expect((await stateOf(target))?.interval_step).toBe(1);
    expect((await stateOf(target))?.review_due_at?.toISOString()).toBe('2026-08-17T15:00:00.000Z');

    // 8/18 복습 슬롯에서 정답 → 3일 뒤(8/21)
    vi.setSystemTime(new Date('2026-08-18T05:00:00Z'));
    await refreshToken();
    const day2 = await startToday();
    await answer(day2.session.id, target, 0);

    expect((await stateOf(target))?.interval_step).toBe(2);
    expect((await stateOf(target))?.review_due_at?.toISOString()).toBe('2026-08-20T15:00:00.000Z');

    // 8/21 정답 → 7일 뒤(8/28)
    vi.setSystemTime(new Date('2026-08-21T05:00:00Z'));
    await refreshToken();
    const day3 = await startToday();
    await answer(day3.session.id, target, 0);

    expect((await stateOf(target))?.interval_step).toBe(3);
    expect((await stateOf(target))?.review_due_at?.toISOString()).toBe('2026-08-27T15:00:00.000Z');

    // 8/28 정답 → 졸업
    vi.setSystemTime(new Date('2026-08-28T05:00:00Z'));
    await refreshToken();
    const day4 = await startToday();
    await answer(day4.session.id, target, 0);

    const graduated = await stateOf(target);
    expect(graduated?.interval_step).toBe(3);
    expect(graduated?.review_due_at).toBeNull();
    expect(graduated?.last_result).toBe('correct');
  });

  it('중간에 다시 틀리면 1일 단계로 되돌아간다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    await refreshToken();
    const first = await playSession(true);
    const target = first.items[0]!.questionRevisionId;

    vi.setSystemTime(new Date('2026-08-18T05:00:00Z'));
    await refreshToken();
    const day2 = await startToday();
    await answer(day2.session.id, target, 0);
    expect((await stateOf(target))?.interval_step).toBe(2);

    // 8/21 재오답
    vi.setSystemTime(new Date('2026-08-21T05:00:00Z'));
    await refreshToken();
    const day3 = await startToday();
    await answer(day3.session.id, target, 1);

    const state = await stateOf(target);
    expect(state?.interval_step).toBe(1);
    expect(state?.review_due_at?.toISOString()).toBe('2026-08-21T15:00:00.000Z');
  });
});

describe('GET /v1/wrong-notes', () => {
  it('인증 없이 조회할 수 없다', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/wrong-notes' });
    expect(response.statusCode).toBe(401);
  });

  it('틀린 문항만 목록에 올라온다', async () => {
    const session = await playSession(true);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/wrong-notes',
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      total: number;
      items: { questionRevisionId: string; selectedIndex: number; reviewed: boolean }[];
    }>();

    expect(body.total).toBe(1);
    expect(body.items[0]?.questionRevisionId).toBe(session.items[0]!.questionRevisionId);
    // 사용자가 실제로 고른 답이 함께 온다.
    expect(body.items[0]?.selectedIndex).toBe(1);
    expect(body.items[0]?.reviewed).toBe(false);
  });

  it('해설과 정답을 함께 준다 (이미 푼 문항이므로)', async () => {
    await playSession(true);

    const body = (
      await app.inject({ method: 'GET', url: '/v1/wrong-notes', headers: auth() })
    ).json<{ items: { correctIndex: number; explanation: string }[] }>();

    expect(body.items[0]?.correctIndex).toBe(0);
    expect(body.items[0]?.explanation).toContain('해설');
  });

  it('시대로 거를 수 있다', async () => {
    await playSession(true);

    const matched = await app.inject({
      method: 'GET',
      url: '/v1/wrong-notes?era=goryeo',
      headers: auth(),
    });
    const other = await app.inject({
      method: 'GET',
      url: '/v1/wrong-notes?era=modern',
      headers: auth(),
    });

    expect(matched.json<{ total: number }>().total).toBe(1);
    expect(other.json<{ total: number }>().total).toBe(0);
  });

  it('void 된 문항은 오답노트에서 빠진다 (07 §9)', async () => {
    const session = await playSession(true);
    await sql`
      update question_revisions set status = 'voided', status_reason = '사실 오류'
      where id = ${session.items[0]!.questionRevisionId}
    `;

    const body = (
      await app.inject({ method: 'GET', url: '/v1/wrong-notes', headers: auth() })
    ).json<{ total: number }>();

    expect(body.total).toBe(0);
  });

  it('retired 문항은 남기되 표시한다', async () => {
    const session = await playSession(true);
    await sql`
      update question_revisions set status = 'retired'
      where id = ${session.items[0]!.questionRevisionId}
    `;

    const body = (
      await app.inject({ method: 'GET', url: '/v1/wrong-notes', headers: auth() })
    ).json<{ items: { retired: boolean }[] }>();

    expect(body.items[0]?.retired).toBe(true);
  });

  it('다른 사용자의 오답은 보이지 않는다', async () => {
    await playSession(true);

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload: { anonKey: 'anon-other-notes' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/wrong-notes',
      headers: { authorization: `Bearer ${other.json<{ accessToken: string }>().accessToken}` },
    });

    expect(response.json<{ total: number }>().total).toBe(0);
  });
});

describe('POST /v1/wrong-notes/:id/review', () => {
  async function firstNote() {
    const body = (
      await app.inject({ method: 'GET', url: '/v1/wrong-notes', headers: auth() })
    ).json<{ items: { canonicalQuestionId: string; reviewDueAt: string | null }[] }>();
    return body.items[0]!;
  }

  it('복습을 기록하면 복습완료로 바뀐다', async () => {
    await playSession(true);
    const note = await firstNote();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/wrong-notes/${note.canonicalQuestionId}/review`,
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ reviewed: boolean }>().reviewed).toBe(true);

    const list = (
      await app.inject({ method: 'GET', url: '/v1/wrong-notes?status=reviewed', headers: auth() })
    ).json<{ total: number }>();
    expect(list.total).toBe(1);
  });

  it('복습 기록은 복습 간격을 바꾸지 않는다 (AGENTS.md §9 #6)', async () => {
    await playSession(true);
    const before = await firstNote();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/wrong-notes/${before.canonicalQuestionId}/review`,
      headers: auth(),
    });

    const body = response.json<{ reviewDueAt: string | null; intervalStep: number }>();
    expect(body.reviewDueAt).toBe(before.reviewDueAt);
    expect(body.intervalStep).toBe(1);
  });

  it('여러 번 호출해도 결과가 같다', async () => {
    await playSession(true);
    const note = await firstNote();

    const first = await app.inject({
      method: 'POST',
      url: `/v1/wrong-notes/${note.canonicalQuestionId}/review`,
      headers: auth(),
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/wrong-notes/${note.canonicalQuestionId}/review`,
      headers: auth(),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ reviewed: boolean }>().reviewed).toBe(true);
  });

  it('오답노트에 없는 문항은 404 다', async () => {
    await playSession(true);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/wrong-notes/00000000-0000-4000-8000-000000000000/review',
      headers: auth(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('다른 사용자의 오답을 복습 처리할 수 없다', async () => {
    await playSession(true);
    const note = await firstNote();

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload: { anonKey: 'anon-other-review' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/wrong-notes/${note.canonicalQuestionId}/review`,
      headers: { authorization: `Bearer ${other.json<{ accessToken: string }>().accessToken}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('다시 틀리면 복습완료 표시가 풀린다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    await refreshToken();

    const session = await playSession(true);
    const target = session.items[0]!.questionRevisionId;
    const note = await firstNote();

    await app.inject({
      method: 'POST',
      url: `/v1/wrong-notes/${note.canonicalQuestionId}/review`,
      headers: auth(),
    });

    // 다음 날 다시 틀린다.
    vi.setSystemTime(new Date('2026-08-18T05:00:00Z'));
    await refreshToken();
    const nextDay = await startToday();
    await answer(nextDay.session.id, target, 1);

    const list = (
      await app.inject({ method: 'GET', url: '/v1/wrong-notes', headers: auth() })
    ).json<{ items: { reviewed: boolean }[] }>();

    expect(list.items[0]?.reviewed).toBe(false);
  });
});
