import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { issueAdminToken } from '../auth/admin-token.ts';
import type { IdentityProvider, VerificationOutcome } from '../auth/identity-provider.ts';
import { createTestClient, insertAdmin, truncateAll } from '../db/test-helpers.ts';
import type { AppInstance } from '../http/types.ts';

/**
 * 문항 CMS 통합 테스트.
 *
 * 핵심 검증: 내용 immutability, published 필수 메타, 상태 전이 규칙, 감사 로그.
 */
class AlwaysValidProvider implements IdentityProvider {
  readonly name = 'stub';
  verifyAnonKey(): Promise<VerificationOutcome> {
    return Promise.resolve({ status: 'valid' });
  }
}

let sql: postgres.Sql;
let app: AppInstance;
let editorToken: string;
let editorId: string;

function content(overrides: Record<string, unknown> = {}) {
  return {
    era: 'goryeo',
    topic: 'politics',
    ability: 'fact',
    difficulty: 2,
    prompt: '다음 설명에 해당하는 고려의 제도는?',
    choices: ['보기 1', '보기 2', '보기 3', '보기 4', '보기 5'],
    correctIndex: 0,
    explanation: '정답 근거 해설입니다.',
    sourceRefs: [{ title: '국사편찬위원회', url: 'https://www.history.go.kr/' }],
    sourceAccessedAt: '2026-08-14',
    rightsType: 'self_created',
    ...overrides,
  };
}

async function tokenFor(role: string, email: string): Promise<{ token: string; id: string }> {
  const id = await insertAdmin(sql, email);
  await sql`update admin_users set role = ${role} where id = ${id}`;
  const issued = await issueAdminToken(id, role);
  return { token: issued.token, id };
}

function authHeaders(token: string, idempotencyKey?: string) {
  return idempotencyKey == null
    ? { authorization: `Bearer ${token}` }
    : { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey };
}

async function createQuestion(
  overrides: Record<string, unknown> = {},
  key = `key-${Math.random().toString(36).slice(2)}`,
): Promise<{ questionId: string; revisionId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/admin/v1/questions',
    headers: authHeaders(editorToken, key),
    payload: content(overrides),
  });

  const body = response.json<{ questionId: string; revisionId: string }>();
  return body;
}

async function setStatus(
  revisionId: string,
  status: string,
  statusReason?: string,
  token = editorToken,
) {
  return await app.inject({
    method: 'PATCH',
    url: `/admin/v1/revisions/${revisionId}/status`,
    headers: authHeaders(token),
    payload: statusReason == null ? { status } : { status, statusReason },
  });
}

/** draft -> review -> approved 까지 올린다. */
async function approve(revisionId: string): Promise<void> {
  await setStatus(revisionId, 'review');
  await setStatus(revisionId, 'approved');
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

  const editor = await tokenFor('editor', 'editor@example.test');
  editorToken = editor.token;
  editorId = editor.id;
});

afterEach(async () => {
  await app.close();
});

describe('POST /admin/v1/questions', () => {
  it('문항과 revision 1 을 draft 로 만든다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/questions',
      headers: authHeaders(editorToken, 'create-1'),
      payload: content(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ revision: number }>().revision).toBe(1);

    const [row] = await sql<{ status: string; revision: number }[]>`
      select status, revision from question_revisions
    `;
    expect(row?.status).toBe('draft');
    expect(row?.revision).toBe(1);
  });

  it('선택지가 5개가 아니면 400 이다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/questions',
      headers: authHeaders(editorToken, 'create-bad'),
      payload: content({ choices: ['1', '2', '3', '4'] }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('정의되지 않은 시대는 400 이다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/questions',
      headers: authHeaders(editorToken, 'create-era'),
      payload: content({ era: 'silla' }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('Idempotency-Key 가 없으면 400 이다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/questions',
      headers: authHeaders(editorToken),
      payload: content(),
    });

    expect(response.statusCode).toBe(400);
  });

  it('reviewer 역할은 문항을 만들 수 없다', async () => {
    const reviewer = await tokenFor('reviewer', 'reviewer@example.test');

    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/questions',
      headers: authHeaders(reviewer.token, 'create-reviewer'),
      payload: content(),
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('POST /admin/v1/questions/:id/revisions', () => {
  it('revision 번호를 서버가 계산한다 (요청값 무시)', async () => {
    const { questionId } = await createQuestion();

    const response = await app.inject({
      method: 'POST',
      url: `/admin/v1/questions/${questionId}/revisions`,
      headers: authHeaders(editorToken, 'rev-2'),
      // 클라이언트가 엉뚱한 번호를 보내도 반영되지 않아야 한다.
      payload: { ...content({ prompt: '수정된 문항입니다.' }), revision: 99 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ revision: number }>().revision).toBe(2);

    const rows = await sql<{ revision: number }[]>`
      select revision from question_revisions order by revision
    `;
    expect(rows.map((row) => row.revision)).toEqual([1, 2]);
  });

  it('없는 문항에는 404 다', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/questions/00000000-0000-4000-8000-000000000000/revisions',
      headers: authHeaders(editorToken, 'rev-404'),
      payload: content(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('내용 수정 API 는 존재하지 않는다 (수정은 새 revision 으로만)', async () => {
    const { revisionId } = await createQuestion();

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/v1/revisions/${revisionId}`,
      headers: authHeaders(editorToken),
      payload: { prompt: '몰래 고치기' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('DB 레벨에서도 내용 수정이 막힌다', async () => {
    const { revisionId } = await createQuestion();

    await expect(
      sql`update question_revisions set prompt = '직접 수정' where id = ${revisionId}`,
    ).rejects.toThrow(/immutable/i);
  });
});

describe('PATCH /admin/v1/revisions/:id/status', () => {
  it('draft -> review -> approved 순서로 올라간다', async () => {
    const { revisionId } = await createQuestion();

    expect((await setStatus(revisionId, 'review')).statusCode).toBe(200);
    expect((await setStatus(revisionId, 'approved')).statusCode).toBe(200);

    const [row] = await sql<{ status: string; reviewer_id: string; reviewed_at: Date }[]>`
      select status, reviewer_id, reviewed_at from question_revisions where id = ${revisionId}
    `;

    expect(row?.status).toBe('approved');
    // 검수자는 서버가 기록한다.
    expect(row?.reviewer_id).toBe(editorId);
    expect(row?.reviewed_at).not.toBeNull();
  });

  it('draft 에서 바로 발행할 수 없다 (409)', async () => {
    const { revisionId } = await createQuestion();

    const response = await setStatus(revisionId, 'published');

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('STATE_CONFLICT');
  });

  it('뒤로 가는 전이를 거부한다 (409)', async () => {
    const { revisionId } = await createQuestion();
    await setStatus(revisionId, 'review');

    expect((await setStatus(revisionId, 'draft')).statusCode).toBe(409);
  });

  it('출처와 검수 정보가 없으면 발행할 수 없다 (422)', async () => {
    // 출처 없이 만든 문항을 승인까지 올린 뒤 발행을 시도한다.
    const { revisionId } = await createQuestion({ sourceRefs: [], sourceAccessedAt: undefined });
    await approve(revisionId);

    const response = await setStatus(revisionId, 'published');

    expect(response.statusCode).toBe(422);
    const body = response.json<{ details: { missing: string[] } }>();
    expect(body.details.missing).toContain('sourceRefs');
    expect(body.details.missing).toContain('sourceAccessedAt');

    // DB 에는 여전히 published 가 없다.
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from question_revisions where status = 'published'
    `;
    expect(row?.count).toBe('0');
  });

  it('권리 구분이 unknown 이면 발행할 수 없다 (422)', async () => {
    const { revisionId } = await createQuestion({ rightsType: 'unknown' });
    await approve(revisionId);

    expect((await setStatus(revisionId, 'published')).statusCode).toBe(422);
  });

  it('reviewer 역할은 검수까지만 하고 발행은 못 한다 (403)', async () => {
    const reviewer = await tokenFor('reviewer', 'reviewer2@example.test');
    const { revisionId } = await createQuestion();

    expect((await setStatus(revisionId, 'review', undefined, reviewer.token)).statusCode).toBe(200);
    expect((await setStatus(revisionId, 'approved', undefined, reviewer.token)).statusCode).toBe(
      200,
    );
    expect((await setStatus(revisionId, 'published', undefined, reviewer.token)).statusCode).toBe(
      403,
    );
  });

  it('void 는 사유 없이 할 수 없다 (400)', async () => {
    const { revisionId } = await createQuestion();
    await approve(revisionId);
    await setStatus(revisionId, 'published');

    expect((await setStatus(revisionId, 'voided')).statusCode).toBe(400);
    expect((await setStatus(revisionId, 'voided', '중대한 사실 오류')).statusCode).toBe(200);
  });

  it('없는 revision 은 404 다', async () => {
    const response = await setStatus('00000000-0000-4000-8000-000000000000', 'review');
    expect(response.statusCode).toBe(404);
  });
});

describe('한 문항에 published 는 하나뿐이다 (09 §2)', () => {
  it('새 revision 을 발행하면 기존 발행본이 자동으로 retired 된다', async () => {
    const { questionId, revisionId } = await createQuestion();
    await approve(revisionId);
    await setStatus(revisionId, 'published');

    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/questions/${questionId}/revisions`,
      headers: authHeaders(editorToken, 'rev-two'),
      payload: content({ prompt: '오타를 고친 문항입니다.' }),
    });
    const secondId = second.json<{ revisionId: string }>().revisionId;

    await approve(secondId);
    expect((await setStatus(secondId, 'published')).statusCode).toBe(200);

    const rows = await sql<{ revision: number; status: string }[]>`
      select revision, status from question_revisions order by revision
    `;

    expect(rows[0]).toMatchObject({ revision: 1, status: 'retired' });
    expect(rows[1]).toMatchObject({ revision: 2, status: 'published' });
  });

  it('동시에 두 revision 을 발행해도 published 는 1개다', async () => {
    const { questionId, revisionId } = await createQuestion();
    await approve(revisionId);

    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/questions/${questionId}/revisions`,
      headers: authHeaders(editorToken, 'race-rev'),
      payload: content({ prompt: '동시 발행 테스트 문항입니다.' }),
    });
    const secondId = second.json<{ revisionId: string }>().revisionId;
    await approve(secondId);

    await Promise.all([setStatus(revisionId, 'published'), setStatus(secondId, 'published')]);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from question_revisions where status = 'published'
    `;
    expect(row?.count).toBe('1');
  });
});

describe('감사 로그 (공통 04 §2)', () => {
  it('생성과 모든 상태 전이를 기록한다', async () => {
    const { revisionId } = await createQuestion();
    await setStatus(revisionId, 'review');
    await setStatus(revisionId, 'approved');
    await setStatus(revisionId, 'published');
    await setStatus(revisionId, 'voided', '사실 오류 확인');

    const rows = await sql<{ action: string }[]>`
      select action from admin_audit_logs order by created_at
    `;

    expect(rows.map((row) => row.action)).toEqual([
      'create_revision',
      'submit_question_review',
      'approve_question',
      'publish_question',
      'void_question',
    ]);
  });

  it('감사 로그에 문항 원문을 넣지 않는다', async () => {
    const { revisionId } = await createQuestion();
    await setStatus(revisionId, 'review');

    const [row] = await sql<{ detail: string }[]>`
      select detail::text as detail from admin_audit_logs where action = 'submit_question_review'
    `;

    expect(row?.detail).not.toContain('고려의 제도');
  });
});

describe('GET /admin/v1/questions', () => {
  it('문항별 최신 revision 을 돌려준다', async () => {
    const { questionId } = await createQuestion();
    await app.inject({
      method: 'POST',
      url: `/admin/v1/questions/${questionId}/revisions`,
      headers: authHeaders(editorToken, 'list-rev2'),
      payload: content({ prompt: '두 번째 revision 입니다.' }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/questions',
      headers: authHeaders(editorToken),
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{ items: { revision: number }[]; total: number }>();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.revision).toBe(2);
  });

  it('시대와 상태로 거를 수 있다', async () => {
    await createQuestion({ era: 'goryeo' }, 'f-1');
    await createQuestion({ era: 'modern' }, 'f-2');

    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/questions?era=modern&status=draft',
      headers: authHeaders(editorToken),
    });

    const body = response.json<{ items: { era: string }[]; total: number }>();
    expect(body.total).toBe(1);
    expect(body.items[0]?.era).toBe('modern');
  });

  it('페이지네이션이 동작한다', async () => {
    await createQuestion({}, 'p-1');
    await createQuestion({}, 'p-2');
    await createQuestion({}, 'p-3');

    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/questions?page=2&limit=2',
      headers: authHeaders(editorToken),
    });

    const body = response.json<{ items: unknown[]; total: number }>();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(1);
  });

  it('reviewer 도 목록을 볼 수 있다', async () => {
    const reviewer = await tokenFor('reviewer', 'reviewer3@example.test');

    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/questions',
      headers: authHeaders(reviewer.token),
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('GET /admin/v1/questions/:id', () => {
  it('revision 이력을 순서대로 돌려준다', async () => {
    const { questionId } = await createQuestion();
    await app.inject({
      method: 'POST',
      url: `/admin/v1/questions/${questionId}/revisions`,
      headers: authHeaders(editorToken, 'hist-2'),
      payload: content({ prompt: '두 번째 revision 입니다.' }),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/admin/v1/questions/${questionId}`,
      headers: authHeaders(editorToken),
    });

    const body = response.json<{ revisions: { revision: number; prompt: string }[] }>();
    expect(body.revisions.map((item) => item.revision)).toEqual([1, 2]);
    // 과거 revision 의 내용이 그대로 남아 있다 (재현 가능).
    expect(body.revisions[0]?.prompt).toContain('고려의 제도');
  });

  it('없는 문항은 404 다', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/questions/00000000-0000-4000-8000-000000000000',
      headers: authHeaders(editorToken),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('GET /admin/v1/coverage', () => {
  it('published 문항만 집계하고 게이트 미달을 알려준다', async () => {
    const { revisionId } = await createQuestion({ era: 'goryeo', topic: 'politics' });
    await approve(revisionId);
    await setStatus(revisionId, 'published');

    // draft 상태 문항은 집계에 들어가지 않는다.
    await createQuestion({ era: 'modern' }, 'cov-draft');

    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/coverage',
      headers: authHeaders(editorToken),
    });

    const body = response.json<{
      total: number;
      gate: { passed: boolean; totalShortfall: number; erasBelowTarget: string[] };
      metadataGaps: number;
    }>();

    expect(body.total).toBe(1);
    expect(body.gate.passed).toBe(false);
    expect(body.gate.totalShortfall).toBe(299);
    expect(body.gate.erasBelowTarget).toContain('goryeo');
    // published 인데 메타가 빈 건은 있으면 안 된다.
    expect(body.metadataGaps).toBe(0);
  });
});
