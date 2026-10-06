import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import { issueAdminToken } from '../auth/admin-token.ts';
import type { IdentityProvider, VerificationOutcome } from '../auth/identity-provider.ts';
import { createTestClient, insertAdmin, insertQuestion, truncateAll } from '../db/test-helpers.ts';
import type { AppInstance } from '../http/types.ts';
import type { AnswerResult, CompleteResult, SessionView } from '../services/study-session.ts';

/**
 * Disposable DB mechanics only, NOT historical review or production approval.
 * Prior content is a version-controlled, identity-free content fixture.
 * Private review and operational records are not required to run this test.
 * IDs, users, approval identities, and pre-existing drafts are test-only MOCK data.
 * The JSON indices are zero-based; canonical IDs are generated in this test DB,
 * not inferred from local file positions or copied from production.
 */
const PRIORITY_INDICES = [
  49, 50, 56, 90, 123, 128, 178, 194, 201, 213, 222, 227, 261, 282,
] as const;
const MOCK_NOW = '2026-10-06T03:00:00.000Z';

// Preserve the current source payload, including optional CMS content metadata.
type LocalContent = {
  era: string;
  topic: string;
  ability: string;
  difficulty: number;
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  sourceRefs: { title: string; url: string }[];
  sourceAccessedAt: string;
  rightsType: string;
  wrongAnswerNotes?: string[];
  memoryKeyword?: string;
  rightsNote?: string;
  aiGenerationMeta?: { model: string; promptVersion: string; generatedAt: string };
};

const bank = JSON.parse(
  readFileSync(new URL('../../../content/all-300.json', import.meta.url), 'utf8'),
) as LocalContent[];
const publishedBefore = JSON.parse(
  readFileSync(new URL('./fixtures/priority-revision-before.json', import.meta.url), 'utf8'),
) as LocalContent[];
if (publishedBefore.length !== PRIORITY_INDICES.length) {
  throw new Error(
    'The identity-free published snapshot must contain all 14 targets in priority order',
  );
}
const priorityContent = PRIORITY_INDICES.map((index, position) => {
  const content = bank[index];
  const prior = publishedBefore[position];
  if (content == null || prior == null) {
    throw new Error(`Missing priority before/after content at index ${index}`);
  }
  return { index, content, prior };
});

class MOCKTestOnlyIdentityProvider implements IdentityProvider {
  readonly name = 'MOCK-test-only-priority-rollout';
  verifyAnonKey(): Promise<VerificationOutcome> {
    return Promise.resolve({ status: 'valid' });
  }
}

type MOCKAdmin = { id: string; token: string };
type RevisionCreated = { questionId: string; revisionId: string; revision: number };
type PriorityFixture = {
  index: number;
  content: LocalContent;
  questionId: string;
  priorRevisionId: string;
  prior: LocalContent;
  existingDraftId: string;
  existingDraft: { prompt: string; choices: string[]; correctIndex: number; explanation: string };
};

let sql: postgres.Sql;
let app: AppInstance;
let mockEditor: MOCKAdmin;
let mockReviewer: MOCKAdmin;
let pool: PriorityFixture[];

function auth(token: string, idempotencyKey?: string) {
  return idempotencyKey == null
    ? { authorization: `Bearer ${token}` }
    : { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey };
}

async function createMOCKAdmin(role: 'editor' | 'reviewer'): Promise<MOCKAdmin> {
  const id = await insertAdmin(sql, `MOCK-test-only-priority-${role}@example.test`);
  await sql`
    update admin_users
    set role = ${role}, display_name = ${`MOCK test-only rollout ${role}; NOT human review`}
    where id = ${id}
  `;
  const issued = await issueAdminToken(id, role);
  return { id, token: issued.token };
}

async function bootstrapMOCKUser(label: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey: `MOCK-test-only-priority-${label}` },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

async function startToday(token: string): Promise<SessionView> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/study/today',
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json<SessionView>();
}

async function answer(
  token: string,
  sessionId: string,
  revisionId: string,
  selectedIndex: number,
): Promise<AnswerResult> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/answer`,
    headers: auth(token),
    payload: { questionRevisionId: revisionId, selectedIndex },
  });
  expect(response.statusCode).toBe(200);
  return response.json<AnswerResult>();
}

async function complete(token: string, sessionId: string): Promise<CompleteResult> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/complete`,
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json<CompleteResult>();
}

async function createCandidate(questionId: string, payload: object, key: string) {
  return await app.inject({
    method: 'POST',
    url: `/admin/v1/questions/${questionId}/revisions`,
    headers: auth(mockEditor.token, key),
    payload,
  });
}

async function setStatus(revisionId: string, status: string, token: string) {
  return await app.inject({
    method: 'PATCH',
    url: `/admin/v1/revisions/${revisionId}/status`,
    headers: auth(token),
    payload: { status },
  });
}

function priorFixture(revisionId: string): PriorityFixture {
  const fixture = pool.find((item) => item.priorRevisionId === revisionId);
  if (fixture == null) throw new Error(`Session escaped the test-only prior pool: ${revisionId}`);
  return fixture;
}

function expectPriorSession(session: SessionView): void {
  expect(session.items).toHaveLength(5);
  expect(new Set(session.items.map((item) => item.questionRevisionId)).size).toBe(5);
  for (const item of session.items) {
    const { prior } = priorFixture(item.questionRevisionId);
    expect(item.prompt).toBe(prior.prompt);
    expect(item.choices).toEqual(prior.choices);
    expect(item.voided).toBe(false);
    if (item.answered) {
      expect(item.correctIndex).toBe(prior.correctIndex);
      expect(item.explanation).toBe(prior.explanation);
    } else {
      expect(item.correctIndex).toBeUndefined();
      expect(item.explanation).toBeUndefined();
    }
  }
}

async function priorRows() {
  return await sql<{ id: string; status: string; immutable: unknown }[]>`
    select id, status,
      to_jsonb(r) - 'status' - 'status_reason' - 'status_changed_at' as immutable
    from question_revisions r where revision = 1 order by id
  `;
}

async function existingDraftRows() {
  return await sql<{ id: string; status: string; record: unknown }[]>`
    select id, status, to_jsonb(r) as record
    from question_revisions r where revision = 2 order by id
  `;
}

async function savedAnswers(sessionId: string) {
  return await sql<{ record: unknown }[]>`
    select to_jsonb(a) as record from answers a
    where session_id = ${sessionId} order by question_revision_id
  `;
}

async function savedSession(sessionId: string) {
  const [row] = await sql<{ record: unknown }[]>`
    select to_jsonb(s) as record from study_sessions s where id = ${sessionId}
  `;
  expect(row).toBeDefined();
  return row?.record;
}

async function pinnedItems(firstId: string, secondId: string) {
  return await sql<
    {
      session_id: string;
      canonical_question_id: string;
      question_revision_id: string;
      slot_index: number;
      slot_source: string;
    }[]
  >`
    select session_id, canonical_question_id, question_revision_id, slot_index, slot_source
    from study_session_items
    where session_id = ${firstId} or session_id = ${secondId}
    order by session_id, slot_index
  `;
}

beforeAll(() => {
  sql = createTestClient();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MOCK_NOW));
  await truncateAll(sql);
  app = await buildApp({ identityProvider: new MOCKTestOnlyIdentityProvider() });
  await app.ready();
  mockEditor = await createMOCKAdmin('editor');
  mockReviewer = await createMOCKAdmin('reviewer');

  pool = [];
  for (const { index, content, prior } of priorityContent) {
    const questionId = await insertQuestion(sql);
    const [row] = await sql<{ id: string }[]>`
      insert into question_revisions (
        question_id, revision, status, era, topic, ability, difficulty,
        prompt, choices, correct_index, explanation, wrong_answer_notes, memory_keyword,
        source_refs, source_accessed_at, rights_type, rights_note, ai_generation_meta,
        reviewer_id, reviewed_at, created_by
      ) values (
        ${questionId}, 1, 'published', ${prior.era}, ${prior.topic},
        ${prior.ability}, ${prior.difficulty}, ${prior.prompt}, ${sql.json(prior.choices)},
        ${prior.correctIndex}, ${prior.explanation},
        ${prior.wrongAnswerNotes == null ? null : sql.json(prior.wrongAnswerNotes)},
        ${prior.memoryKeyword ?? null}, ${sql.json(prior.sourceRefs)},
        ${prior.sourceAccessedAt}, ${prior.rightsType}, ${prior.rightsNote ?? null},
        ${prior.aiGenerationMeta == null ? null : sql.json(prior.aiGenerationMeta)},
        ${mockReviewer.id}, now(), ${mockEditor.id}
      ) returning id
    `;
    if (row == null) throw new Error(`Could not seed test-only prior revision for index ${index}`);

    // Actual revision-2 draft content is not in the read-only snapshot: preserve a
    // deliberately distinct MOCK draft, with no reviewer/approval metadata.
    const existingDraft = {
      prompt: `MOCK test-only pre-existing September 24 draft for index ${index}; NOT current candidate`,
      choices: Array.from(
        { length: 5 },
        (_, choice) => `MOCK preserved draft ${index} choice ${choice}`,
      ),
      correctIndex: (prior.correctIndex + 1) % 5,
      explanation: `MOCK test-only unpublished draft for index ${index}; NOT historical review`,
    };
    const [draft] = await sql<{ id: string }[]>`
      insert into question_revisions (
        question_id, revision, status, era, topic, ability, difficulty,
        prompt, choices, correct_index, explanation, created_by, created_at
      ) values (
        ${questionId}, 2, 'draft', ${prior.era}, ${prior.topic},
        ${prior.ability}, ${prior.difficulty}, ${existingDraft.prompt},
        ${sql.json(existingDraft.choices)}, ${existingDraft.correctIndex}, ${existingDraft.explanation},
        ${mockEditor.id}, '2026-09-24T03:00:00.000Z'
      ) returning id
    `;
    if (draft == null) throw new Error(`Could not seed MOCK existing draft for index ${index}`);
    pool.push({
      index,
      content,
      questionId,
      priorRevisionId: row.id,
      prior,
      existingDraftId: draft.id,
      existingDraft,
    });
  }
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe('priority revision staged rollout (test-only MOCK approvals, not release approval)', () => {
  // This is a 14-item sequential operational rehearsal, not a response-time test.
  // Keep every API/assertion enabled; allow slower disposable Docker databases.
  it('publishes revision 3 for all 14 IDs while preserving prior sessions and revision-2 drafts', async () => {
    const completedToken = await bootstrapMOCKUser('completed-before-rollout');
    const inProgressToken = await bootstrapMOCKUser('in-progress-before-rollout');
    const completed = await startToday(completedToken);
    const inProgress = await startToday(inProgressToken);
    expectPriorSession(completed);
    expectPriorSession(inProgress);

    // Mixed results ensure the persisted score is meaningful, not a default or all-zero score.
    for (const item of completed.items) {
      const { prior } = priorFixture(item.questionRevisionId);
      const correct = item.slotIndex < 4;
      const result = await answer(
        completedToken,
        completed.session.id,
        item.questionRevisionId,
        correct ? prior.correctIndex : (prior.correctIndex + 1) % 5,
      );
      expect(result).toMatchObject({
        isCorrect: correct,
        correctIndex: prior.correctIndex,
        explanation: prior.explanation,
      });
    }
    const originalCompletion = await complete(completedToken, completed.session.id);
    expect(originalCompletion.session.score).toBe(4);
    expect(originalCompletion.validCount).toBe(5);

    const firstInProgress = inProgress.items[0]!;
    await answer(
      inProgressToken,
      inProgress.session.id,
      firstInProgress.questionRevisionId,
      priorFixture(firstInProgress.questionRevisionId).prior.correctIndex,
    );
    const completedBefore = await startToday(completedToken);
    const inProgressBefore = await startToday(inProgressToken);
    const completedDBBefore = await savedSession(completed.session.id);
    const inProgressDBBefore = await savedSession(inProgress.session.id);
    const completedAnswersBefore = await savedAnswers(completed.session.id);
    const inProgressAnswersBefore = await savedAnswers(inProgress.session.id);
    const pinnedBefore = await pinnedItems(completed.session.id, inProgress.session.id);
    const priorBefore = await priorRows();
    const draftsBefore = await existingDraftRows();
    expect(completedAnswersBefore).toHaveLength(5);
    expect(inProgressAnswersBefore).toHaveLength(1);
    expect(pinnedBefore).toHaveLength(10);
    expect(priorBefore).toHaveLength(PRIORITY_INDICES.length);
    expect(priorBefore.every((row) => row.status === 'published')).toBe(true);
    expect(draftsBefore).toHaveLength(PRIORITY_INDICES.length);
    expect(draftsBefore.every((row) => row.status === 'draft')).toBe(true);

    // Stage 1: create drafts under the SAME canonical IDs; retry every POST unchanged.
    const candidates: { fixture: PriorityFixture; created: RevisionCreated; key: string }[] = [];
    for (const fixture of pool) {
      const key = `MOCK-test-only-priority-${fixture.index}-revision-3`;
      const response = await createCandidate(fixture.questionId, fixture.content, key);
      expect(response.statusCode).toBe(201);
      const created = response.json<RevisionCreated>();
      expect(created).toMatchObject({ questionId: fixture.questionId, revision: 3 });
      expect(created.revisionId).not.toBe(fixture.priorRevisionId);
      expect(created.revisionId).not.toBe(fixture.existingDraftId);
      const retry = await createCandidate(fixture.questionId, fixture.content, key);
      expect(retry.statusCode).toBe(201);
      expect(retry.headers['idempotent-replay']).toBe('true');
      expect(retry.json<RevisionCreated>()).toEqual(created);
      // Complete source/rights metadata alone is NOT approval, for any of the 14 candidates.
      const unapproved = await setStatus(created.revisionId, 'published', mockEditor.token);
      expect(unapproved.statusCode).toBe(409);
      expect(unapproved.json<{ code: string }>().code).toBe('STATE_CONFLICT');
      candidates.push({ fixture, created, key });
    }
    const staged = await sql<{ status: string; count: number }[]>`
      select status, count(*)::int as count from question_revisions group by status order by status
    `;
    expect(staged).toEqual([
      { status: 'draft', count: 28 },
      { status: 'published', count: 14 },
    ]);
    expect(await existingDraftRows()).toEqual(draftsBefore);

    // Stage 2: isolated MOCK reviewer transitions. This is NOT human factual validation.
    // Separate editor/reviewer actors also keep the real 60 writes/min limit enabled.
    for (const { created } of candidates) {
      expect((await setStatus(created.revisionId, 'review', mockReviewer.token)).statusCode).toBe(
        200,
      );
      if (created.revisionId === candidates[0]!.created.revisionId) {
        const unapproved = await setStatus(created.revisionId, 'published', mockEditor.token);
        expect(unapproved.statusCode).toBe(409);
        expect(unapproved.json<{ code: string }>().code).toBe('STATE_CONFLICT');
      }
      expect((await setStatus(created.revisionId, 'approved', mockReviewer.token)).statusCode).toBe(
        200,
      );
    }
    const approved = await sql<{ reviewer_id: string; reviewed_at: Date }[]>`
      select reviewer_id, reviewed_at from question_revisions where revision = 3 and status = 'approved'
    `;
    expect(approved).toHaveLength(14);
    for (const row of approved) {
      expect(row.reviewer_id).toBe(mockReviewer.id);
      expect(row.reviewed_at).not.toBeNull();
    }
    expect((await priorRows()).every((row) => row.status === 'published')).toBe(true);
    expect(await existingDraftRows()).toEqual(draftsBefore);

    // Stage 3: publish via the actual admin API; retirement must happen in application transactions.
    for (const { created } of candidates) {
      expect((await setStatus(created.revisionId, 'published', mockEditor.token)).statusCode).toBe(
        200,
      );
    }
    const priorAfter = await priorRows();
    expect(priorAfter.map((row) => ({ id: row.id, immutable: row.immutable }))).toEqual(
      priorBefore.map((row) => ({ id: row.id, immutable: row.immutable })),
    );
    expect(priorAfter.every((row) => row.status === 'retired')).toBe(true);
    expect(await existingDraftRows()).toEqual(draftsBefore);

    const canonicalCounts = await sql<
      {
        question_id: string;
        revisions: number;
        published: number;
      }[]
    >`
      select question_id, count(*)::int as revisions,
        count(*) filter (where status = 'published')::int as published
      from question_revisions group by question_id
    `;
    expect(canonicalCounts).toHaveLength(14);
    expect(canonicalCounts.map((row) => row.question_id).sort()).toEqual(
      pool.map((fixture) => fixture.questionId).sort(),
    );
    for (const row of canonicalCounts) expect(row).toMatchObject({ revisions: 3, published: 1 });
    const [canonicalTotal] = await sql<
      { count: number }[]
    >`select count(*)::int as count from questions`;
    expect(canonicalTotal?.count).toBe(14);

    for (const { fixture, created } of candidates) {
      const history = await app.inject({
        method: 'GET',
        url: `/admin/v1/questions/${fixture.questionId}`,
        headers: auth(mockEditor.token),
      });
      expect(history.statusCode).toBe(200);
      const revisions = history.json<{ revisions: Record<string, unknown>[] }>().revisions;
      expect(revisions).toHaveLength(3);
      expect(revisions[0]).toMatchObject({
        id: fixture.priorRevisionId,
        status: 'retired',
        ...fixture.prior,
      });
      expect(revisions[1]).toMatchObject({
        ...fixture.existingDraft,
        id: fixture.existingDraftId,
        revision: 2,
        status: 'draft',
        reviewerId: null,
        reviewedAt: null,
      });
      expect(revisions[2]).toMatchObject({
        ...fixture.content,
        id: created.revisionId,
        questionId: fixture.questionId,
        revision: 3,
        status: 'published',
        reviewerId: mockReviewer.id,
        createdBy: mockEditor.id,
      });
    }
    const audit = await sql<{ action: string; actor_admin_id: string; count: number }[]>`
      select action, actor_admin_id, count(*)::int as count from admin_audit_logs
      group by action, actor_admin_id order by action
    `;
    expect(audit).toEqual([
      { action: 'approve_question', actor_admin_id: mockReviewer.id, count: 14 },
      { action: 'create_revision', actor_admin_id: mockEditor.id, count: 14 },
      { action: 'publish_question', actor_admin_id: mockEditor.id, count: 14 },
      { action: 'submit_question_review', actor_admin_id: mockReviewer.id, count: 14 },
    ]);

    // Requery both pre-rollout users: API views and persisted slot/revision/canonical bindings are unchanged.
    expect(await startToday(completedToken)).toEqual(completedBefore);
    expect(await startToday(inProgressToken)).toEqual(inProgressBefore);
    expect(await savedSession(completed.session.id)).toEqual(completedDBBefore);
    expect(await savedSession(inProgress.session.id)).toEqual(inProgressDBBefore);
    expect(await savedAnswers(completed.session.id)).toEqual(completedAnswersBefore);
    expect(await savedAnswers(inProgress.session.id)).toEqual(inProgressAnswersBefore);
    expect(await pinnedItems(completed.session.id, inProgress.session.id)).toEqual(pinnedBefore);
    const replayCompletion = await complete(completedToken, completed.session.id);
    expect(replayCompletion).toEqual({ ...originalCompletion, alreadyCompleted: true });

    // Retired is NOT voided: an already assigned, still-unanswered revision remains answerable.
    for (const item of inProgress.items.slice(1)) {
      const fixture = priorFixture(item.questionRevisionId);
      const result = await answer(
        inProgressToken,
        inProgress.session.id,
        item.questionRevisionId,
        fixture.prior.correctIndex,
      );
      expect(result).toMatchObject({
        isCorrect: true,
        correctIndex: fixture.prior.correctIndex,
        explanation: fixture.prior.explanation,
        replayed: false,
      });
    }
    expect((await complete(inProgressToken, inProgress.session.id)).session.score).toBe(5);
    const finishedPrior = await startToday(inProgressToken);
    expectPriorSession(finishedPrior);
    expect(finishedPrior.items.map((item) => item.questionRevisionId)).toEqual(
      inProgress.items.map((item) => item.questionRevisionId),
    );
    expect(await pinnedItems(completed.session.id, inProgress.session.id)).toEqual(pinnedBefore);

    // Fresh user sees five slots from the target-only pool, all bound to replacement revisions.
    const freshToken = await bootstrapMOCKUser('fresh-after-rollout');
    const fresh = await startToday(freshToken);
    expect(fresh.items).toHaveLength(5);
    expect(fresh.session.id).not.toBe(completed.session.id);
    expect(fresh.session.id).not.toBe(inProgress.session.id);
    for (const item of fresh.items) {
      const candidate = candidates.find(
        (entry) => entry.created.revisionId === item.questionRevisionId,
      );
      expect(candidate).toBeDefined();
      if (candidate == null) throw new Error('Fresh session selected outside the replacement pool');
      expect(item.prompt).toBe(candidate.fixture.content.prompt);
      expect(item.choices).toEqual(candidate.fixture.content.choices);
      expect(item.answered).toBe(false);
      expect(item.correctIndex).toBeUndefined();
      expect(pool.map((fixture) => fixture.priorRevisionId)).not.toContain(item.questionRevisionId);
    }
    const freshBindings = await sql<
      { question_revision_id: string; status: string; revision: number }[]
    >`
      select i.question_revision_id, r.status, r.revision
      from study_session_items i join question_revisions r on r.id = i.question_revision_id
      where i.session_id = ${fresh.session.id} order by i.slot_index
    `;
    expect(freshBindings).toHaveLength(5);
    for (const row of freshBindings)
      expect(row).toMatchObject({ status: 'published', revision: 3 });

    // A late network retry after publication still replays revision 3, not a new revision 4.
    const late = candidates[0]!;
    const lateRetry = await createCandidate(
      late.fixture.questionId,
      late.fixture.content,
      late.key,
    );
    expect(lateRetry.statusCode).toBe(201);
    expect(lateRetry.headers['idempotent-replay']).toBe('true');
    expect(lateRetry.json<RevisionCreated>()).toEqual(late.created);
    const [revisionTotal] = await sql<{ count: number }[]>`
      select count(*)::int as count from question_revisions
    `;
    expect(revisionTotal?.count).toBe(42);
    expect(await existingDraftRows()).toEqual(draftsBefore);
  }, 60_000);

  it('blocks unapproved and metadata-incomplete candidates without retiring the prior publication', async () => {
    const fixture = pool[0]!;
    const draftsBefore = await existingDraftRows();
    const response = await createCandidate(
      fixture.questionId,
      {
        ...fixture.content,
        sourceRefs: [],
        sourceAccessedAt: undefined,
        rightsType: 'unknown',
        // Client-supplied MOCK approval fields must be ignored, not treated as review.
        reviewerId: mockReviewer.id,
        reviewedAt: MOCK_NOW,
      },
      'MOCK-test-only-priority-metadata-gate',
    );
    expect(response.statusCode).toBe(201);
    const candidate = response.json<RevisionCreated>();
    expect(candidate).toMatchObject({ questionId: fixture.questionId, revision: 3 });

    for (const status of ['draft', 'review']) {
      if (status === 'review') {
        expect(
          (await setStatus(candidate.revisionId, 'review', mockReviewer.token)).statusCode,
        ).toBe(200);
      }
      const blocked = await setStatus(candidate.revisionId, 'published', mockEditor.token);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json<{ code: string }>().code).toBe('STATE_CONFLICT');
      const [row] = await sql<
        { status: string; reviewer_id: string | null; reviewed_at: Date | null }[]
      >`
        select status, reviewer_id, reviewed_at from question_revisions where id = ${candidate.revisionId}
      `;
      expect(row).toMatchObject({ status, reviewer_id: null, reviewed_at: null });
    }

    expect((await setStatus(candidate.revisionId, 'approved', mockReviewer.token)).statusCode).toBe(
      200,
    );
    const missingMeta = await setStatus(candidate.revisionId, 'published', mockEditor.token);
    expect(missingMeta.statusCode).toBe(422);
    expect(missingMeta.json<{ code: string; details: { missing: string[] } }>()).toMatchObject({
      code: 'PUBLISH_REQUIREMENTS_MISSING',
      details: { missing: ['sourceRefs', 'sourceAccessedAt', 'rightsType'] },
    });
    // PostgreSQL is also a real final metadata guard, not just an HTTP assertion.
    await expect(
      sql`update question_revisions set status = 'published' where id = ${candidate.revisionId}`,
    ).rejects.toThrow(/question_revisions_publish_requirements_check/);

    const rows = await sql<{ id: string; status: string; reviewer_id: string | null }[]>`
      select id, status, reviewer_id from question_revisions
      where question_id = ${fixture.questionId} order by revision
    `;
    expect(rows).toEqual([
      { id: fixture.priorRevisionId, status: 'published', reviewer_id: mockReviewer.id },
      { id: fixture.existingDraftId, status: 'draft', reviewer_id: null },
      { id: candidate.revisionId, status: 'approved', reviewer_id: mockReviewer.id },
    ]);
    expect(await existingDraftRows()).toEqual(draftsBefore);
    const [published] = await sql<{ count: number }[]>`
      select count(*)::int as count from question_revisions where status = 'published'
    `;
    expect(published?.count).toBe(14);
    const [publishAudit] = await sql<{ count: number }[]>`
      select count(*)::int as count from admin_audit_logs where action = 'publish_question'
    `;
    expect(publishAudit?.count).toBe(0);
  });
});
