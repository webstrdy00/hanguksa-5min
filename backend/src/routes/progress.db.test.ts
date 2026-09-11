import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { recalculateMastery } from '../services/progress.ts';

/**
 * 학습현황 통합 테스트 (07 §3, 08 §2).
 *
 * 표시 규칙 위반이 가장 위험하다: 표본이 적은데 퍼센트를 보여주거나
 * 모델 점수/합격 확률이 새어 나가면 안 된다.
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
let userId: string;

interface SessionResponse {
  session: { id: string };
  items: { questionRevisionId: string; era: string; voided: boolean }[];
}

function auth() {
  return { authorization: `Bearer ${token}` };
}

async function refreshToken(): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey: 'anon-progress-user' },
  });
  token = response.json<{ accessToken: string }>().accessToken;
}

/** 지정한 시대의 published 문항을 원하는 수만큼 만든다. */
async function seedQuestions(era: string, topic: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const questionId = await insertQuestion(sql);
    await insertRevision(sql, { questionId, reviewerId, era, topic });
  }
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

interface ProgressBody {
  eras: {
    era: string;
    seenCount: number;
    correctCount: number;
    accuracyPercent: number | null;
    status: string;
  }[];
  summary: { totalSeen: number; accuracyPercent: number | null; weakEras: string[] };
  streak: { days: number };
  recentDays: { studyDate: string; completed: boolean; score: number | null }[];
}

async function loadProgressBody(): Promise<ProgressBody> {
  const response = await app.inject({ method: 'GET', url: '/v1/progress', headers: auth() });
  return response.json<ProgressBody>();
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
  await refreshToken();

  const [row] = await sql<{ id: string }[]>`select id from users limit 1`;
  userId = row!.id;
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe('GET /v1/progress', () => {
  it('인증 없이 조회할 수 없다', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/progress' });
    expect(response.statusCode).toBe(401);
  });

  it('학습 이력이 없어도 8개 시대를 모두 돌려준다', async () => {
    const body = await loadProgressBody();

    expect(body.eras).toHaveLength(8);
    expect(body.summary.totalSeen).toBe(0);
    expect(body.summary.accuracyPercent).toBeNull();
    expect(body.streak.days).toBe(0);
  });

  it('답안이 시대별 숙련도에 반영된다', async () => {
    await seedQuestions('goryeo', 'politics', 6);

    const session = await startToday();
    for (const item of session.items) {
      await answer(session.session.id, item.questionRevisionId, 0);
    }

    const body = await loadProgressBody();
    const goryeo = body.eras.find((era) => era.era === 'goryeo');

    expect(goryeo?.seenCount).toBe(5);
    expect(goryeo?.correctCount).toBe(5);
    expect(goryeo?.accuracyPercent).toBe(100);
  });

  it('노출 5회 미만이면 퍼센트를 내려보내지 않는다 (07 §3)', async () => {
    await seedQuestions('goryeo', 'politics', 6);

    const session = await startToday();
    // 3문항만 푼다.
    for (const item of session.items.slice(0, 3)) {
      await answer(session.session.id, item.questionRevisionId, 0);
    }

    const body = await loadProgressBody();
    const goryeo = body.eras.find((era) => era.era === 'goryeo');

    expect(goryeo?.seenCount).toBe(3);
    expect(goryeo?.accuracyPercent).toBeNull();
    expect(goryeo?.status).toBe('insufficient_data');
  });

  it('응답에 모델 점수나 확률 표현이 없다', async () => {
    await seedQuestions('goryeo', 'politics', 6);
    const session = await startToday();
    for (const item of session.items) {
      await answer(session.session.id, item.questionRevisionId, 0);
    }

    const response = await app.inject({ method: 'GET', url: '/v1/progress', headers: auth() });

    expect(response.body).not.toContain('smoothed');
    expect(response.body).not.toContain('probability');
    expect(response.body).not.toContain('합격');
  });

  it('최근 7일 이력을 빈 날까지 채워서 돌려준다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    await refreshToken();
    await seedQuestions('goryeo', 'politics', 6);

    const session = await startToday();
    for (const item of session.items) {
      await answer(session.session.id, item.questionRevisionId, 0);
    }
    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.session.id}/complete`,
      headers: auth(),
    });

    const body = await loadProgressBody();

    expect(body.recentDays).toHaveLength(7);
    expect(body.recentDays.at(-1)?.studyDate).toBe('2026-08-17');
    expect(body.recentDays.at(-1)?.completed).toBe(true);
    expect(body.recentDays.at(-1)?.score).toBe(5);
    // 학습하지 않은 날도 자리를 채운다.
    expect(body.recentDays[0]?.completed).toBe(false);
    expect(body.recentDays[0]?.score).toBeNull();
  });

  it('다른 사용자의 숙련도가 섞이지 않는다', async () => {
    await seedQuestions('goryeo', 'politics', 6);
    const session = await startToday();
    for (const item of session.items) {
      await answer(session.session.id, item.questionRevisionId, 0);
    }

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload: { anonKey: 'anon-other-progress' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/progress',
      headers: { authorization: `Bearer ${other.json<{ accessToken: string }>().accessToken}` },
    });

    expect(response.json<ProgressBody>().summary.totalSeen).toBe(0);
  });
});

describe('취약 시대 판정', () => {
  it('정답률이 낮은 시대를 취약으로 표시한다', async () => {
    await seedQuestions('goryeo', 'politics', 6);
    await seedQuestions('modern', 'politics', 6);

    // 고려는 전부 정답, 현대는 전부 오답으로 채운다.
    for (let day = 0; day < 3; day += 1) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`2026-08-${String(15 + day).padStart(2, '0')}T05:00:00Z`));
      await refreshToken();

      const session = await startToday();
      for (const item of session.items) {
        await answer(session.session.id, item.questionRevisionId, item.era === 'goryeo' ? 0 : 3);
      }
    }
    vi.useRealTimers();
    await refreshToken();

    const body = await loadProgressBody();

    expect(body.summary.weakEras).toContain('modern');
    expect(body.summary.weakEras).not.toContain('goryeo');
  });
});

describe('recalculateMastery (07 §9 void 재계산)', () => {
  it('void 된 문항을 빼고 정답률을 보정한다', async () => {
    await seedQuestions('goryeo', 'politics', 6);

    const session = await startToday();
    // 전부 오답으로 제출한다.
    for (const item of session.items) {
      await answer(session.session.id, item.questionRevisionId, 3);
    }

    const before = await loadProgressBody();
    expect(before.eras.find((era) => era.era === 'goryeo')?.accuracyPercent).toBe(0);

    // 그중 3문항이 중대 오류로 void 처리된다.
    const voidedIds = session.items.slice(0, 3).map((item) => item.questionRevisionId);
    await sql`
      update question_revisions set status = 'voided', status_reason = '사실 오류'
      where id = any(${sql.array(voidedIds)}::uuid[])
    `;

    await recalculateMastery(userId, new Date());

    const after = await loadProgressBody();
    const goryeo = after.eras.find((era) => era.era === 'goryeo');

    // 유효 문항이 2개로 줄었으니 데이터 부족으로 내려간다.
    expect(goryeo?.seenCount).toBe(2);
    expect(goryeo?.accuracyPercent).toBeNull();
  });

  it('여러 번 돌려도 결과가 같다 (멱등)', async () => {
    await seedQuestions('goryeo', 'politics', 6);

    const session = await startToday();
    for (const item of session.items) {
      await answer(session.session.id, item.questionRevisionId, 0);
    }

    const first = await recalculateMastery(userId, new Date());
    const second = await recalculateMastery(userId, new Date());

    expect(second).toEqual(first);

    const body = await loadProgressBody();
    expect(body.eras.find((era) => era.era === 'goryeo')?.seenCount).toBe(5);
  });

  it('재계산 시각을 기록한다', async () => {
    await seedQuestions('goryeo', 'politics', 6);
    const session = await startToday();
    await answer(session.session.id, session.items[0]!.questionRevisionId, 0);

    await recalculateMastery(userId, new Date('2026-08-17T09:00:00Z'));

    const [row] = await sql<{ recalculated_at: Date | null }[]>`
      select recalculated_at from mastery limit 1
    `;
    expect(row?.recalculated_at?.toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });
});
