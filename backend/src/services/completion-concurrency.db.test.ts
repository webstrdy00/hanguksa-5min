import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createQuestionPool,
  createTestClient,
  fillSessionItems,
  insertAdmin,
  insertSession,
  insertUser,
  truncateAll,
} from '../db/test-helpers.ts';
import { requestDeletion, runPendingDeletionJobs } from './deletion.ts';
import { completeSession, submitAnswer } from './study-session.ts';

// KST 2026-10-05 00:30: both yesterday's grace window and today's session are open.
const NOW = new Date('2026-10-04T15:30:00Z');
const YESTERDAY = '2026-10-04';
const TODAY = '2026-10-05';
let sql: postgres.Sql;
let userId: string;
let pool: { questionId: string; revisionId: string }[];

async function createAnsweredSession(studyDate: string, answeredCount = 5): Promise<string> {
  return await sql.begin(async (tx) => {
    const sessionId = await insertSession(tx, userId, studyDate);
    await fillSessionItems(tx, sessionId, pool);
    for (const [index, item] of pool.slice(0, answeredCount).entries()) {
      await tx`
        insert into answers (session_id, question_revision_id, selected_index, is_correct)
        values (${sessionId}, ${item.revisionId}, ${index === 0 ? 1 : 0}, ${index !== 0})
      `;
    }
    return sessionId;
  });
}

async function profile() {
  const [row] = await sql<{ streak_days: number; last_streak_date: string }[]>`
    select streak_days, last_streak_date::text from users where id = ${userId}
  `;
  return row;
}

async function storedSession(sessionId: string) {
  const [row] = await sql<
    { study_date: string; score: number | null; completed_at: Date | null }[]
  >`
    select study_date::text, score, completed_at from study_sessions where id = ${sessionId}
  `;
  return row;
}

// A separate transaction holds a real row lock. No timers or service results are mocked.
async function holdLock(
  acquire: (tx: postgres.TransactionSql) => Promise<unknown>,
  beforeCommit?: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<{ pid: number; release: () => void; done: Promise<unknown> }> {
  let release!: () => void;
  let acquired!: (pid: number) => void;
  let failed!: (error: unknown) => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<number>((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  const done = sql.begin(async (tx) => {
    const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    await acquire(tx);
    acquired(backend!.pid);
    await released;
    await beforeCommit?.(tx);
  });
  void done.catch(failed);
  return { pid: await ready, release, done };
}

async function blockedBy(blockerPid: number, queryFragment: string): Promise<number> {
  let pid = 0;
  await expect
    .poll(
      async () => {
        const rows = await sql<{ pid: number }[]>`
          select pid from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and state = 'active' and ${blockerPid} = any(pg_blocking_pids(pid))
            and position(${queryFragment} in query) > 0
          order by pid
        `;
        pid = rows[0]?.pid ?? 0;
        return pid;
      },
      { timeout: 5_000, interval: 10 },
    )
    .toBeGreaterThan(0);
  return pid;
}

function track<T>(pending: Promise<unknown>[], operation: Promise<T>): Promise<T> {
  pending.push(operation);
  void operation.catch(() => undefined);
  return operation;
}

beforeAll(() => {
  sql = createTestClient();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await truncateAll(sql);
  userId = await insertUser(sql, 'issue9-completion-user');
  const reviewerId = await insertAdmin(sql);
  pool = await createQuestionPool(sql, reviewerId);
  await sql`
    update users set streak_days = 5, last_streak_date = '2026-10-03' where id = ${userId}
  `;
});

describe('issue9: completion transactions serialize per user', () => {
  it('only one concurrent request reports a new completion; the other replays it', async () => {
    const sessionId = await createAnsweredSession(TODAY);
    const gate = await holdLock(
      async (tx) => await tx`select id from study_sessions where id = ${sessionId} for update`,
    );
    const pending: Promise<unknown>[] = [];
    try {
      const first = track(pending, completeSession(userId, sessionId, NOW));
      const completionPid = await blockedBy(gate.pid, 'update "study_sessions"');
      const second = track(pending, completeSession(userId, sessionId, NOW));
      // The first owns the user lock; the second must not read stale completed_at/streak.
      await blockedBy(completionPid, 'from "users"');
      expect(await storedSession(sessionId)).toEqual({
        study_date: TODAY,
        score: null,
        completed_at: null,
      });
      gate.release();
      await gate.done;
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.alreadyCompleted)).toEqual([false, true]);
      expect(results.filter((result) => !result.alreadyCompleted)).toHaveLength(1);
      expect(results[0].session).toEqual(results[1].session);
      expect(results[0].streak).toEqual(results[1].streak);
      expect(results[0]).toMatchObject({
        session: { id: sessionId, studyDate: TODAY, score: 4 },
        streak: { days: 1, lastStreakDate: TODAY },
        validCount: 5,
      });
      const stored = await storedSession(sessionId);
      expect(stored?.score).toBe(4);
      expect(stored?.completed_at?.toISOString()).toBe(results[0].session.completedAt);
      expect(await profile()).toEqual({ streak_days: 1, last_streak_date: TODAY });
      const [answers] = await sql<{ count: number }[]>`
        select count(*)::integer as count from answers where session_id = ${sessionId}
      `;
      expect(answers?.count).toBe(5);
    } finally {
      gate.release();
      await gate.done;
      await Promise.allSettled(pending);
    }
  });

  it.each(['yesterday first', 'today first'] as const)(
    'grace-window race: %s keeps the latest study date and serial streak',
    async (order) => {
      const yesterdayId = await createAnsweredSession(YESTERDAY);
      const todayId = await createAnsweredSession(TODAY);
      const firstId = order === 'yesterday first' ? yesterdayId : todayId;
      const secondId = order === 'yesterday first' ? todayId : yesterdayId;
      const gate = await holdLock(
        async (tx) => await tx`select id from study_sessions where id = ${firstId} for update`,
      );
      const pending: Promise<unknown>[] = [];
      try {
        const first = track(pending, completeSession(userId, firstId, NOW));
        const completionPid = await blockedBy(gate.pid, 'update "study_sessions"');
        const second = track(pending, completeSession(userId, secondId, NOW));
        await blockedBy(completionPid, 'from "users"');
        gate.release();
        await gate.done;
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect([firstResult.alreadyCompleted, secondResult.alreadyCompleted]).toEqual([
          false,
          false,
        ]);
        expect(firstResult.session.studyDate).toBe(order === 'yesterday first' ? YESTERDAY : TODAY);
        expect(secondResult.session.studyDate).toBe(
          order === 'yesterday first' ? TODAY : YESTERDAY,
        );
        expect(firstResult.streak).toEqual({
          days: order === 'yesterday first' ? 6 : 1,
          lastStreakDate: order === 'yesterday first' ? YESTERDAY : TODAY,
        });
        // A late yesterday completion preserves today's reset; it does not backfill streak.
        const days = order === 'yesterday first' ? 7 : 1;
        expect(secondResult.streak).toEqual({ days, lastStreakDate: TODAY });
        expect(await profile()).toEqual({ streak_days: days, last_streak_date: TODAY });
        expect(await storedSession(yesterdayId)).toMatchObject({ study_date: YESTERDAY, score: 4 });
        expect(await storedSession(todayId)).toMatchObject({ study_date: TODAY, score: 4 });

        const afterExpiry = new Date('2026-10-04T16:00:00Z');
        const replayFirst = await completeSession(userId, firstId, afterExpiry);
        const replaySecond = await completeSession(userId, secondId, afterExpiry);
        expect(replayFirst.alreadyCompleted).toBe(true);
        expect(replaySecond.alreadyCompleted).toBe(true);
        expect(replayFirst.session).toEqual(firstResult.session);
        expect(replaySecond.session).toEqual(secondResult.session);
        expect(replayFirst.streak).toEqual({ days, lastStreakDate: TODAY });
        expect(replaySecond.streak).toEqual(replayFirst.streak);
        expect(await profile()).toEqual({ streak_days: days, last_streak_date: TODAY });
      } finally {
        gate.release();
        await gate.done;
        await Promise.allSettled(pending);
      }
    },
  );

  it('a concurrent final answer holds the user lock before completion reads progress', async () => {
    const sessionId = await createAnsweredSession(TODAY, 0);
    for (const [index, item] of pool.slice(0, 4).entries()) {
      await submitAnswer(userId, sessionId, item.revisionId, index === 0 ? 1 : 0, NOW);
    }
    await expect(completeSession(userId, sessionId, NOW)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      details: { required: 5 },
    });
    const finalItem = pool[4]!;
    const gate = await holdLock(
      async (tx) =>
        await tx`select id from questions where id = ${finalItem.questionId} for update`,
    );
    const pending: Promise<unknown>[] = [];
    try {
      const answer = track(pending, submitAnswer(userId, sessionId, finalItem.revisionId, 0, NOW));
      const answerPid = await blockedBy(gate.pid, 'for key share');
      const completion = track(pending, completeSession(userId, sessionId, NOW));
      await blockedBy(answerPid, 'from "users"');
      gate.release();
      await gate.done;
      expect((await answer).replayed).toBe(false);
      expect(await completion).toMatchObject({
        session: { id: sessionId, score: 4, studyDate: TODAY },
        validCount: 5,
        alreadyCompleted: false,
      });
      const [mastery] = await sql<{ seen_count: number; correct_count: number }[]>`
        select seen_count, correct_count from mastery where user_id = ${userId}
      `;
      expect(mastery).toEqual({ seen_count: 5, correct_count: 4 });
      const [state] = await sql<{ correct_count: number; wrong_count: number }[]>`
        select correct_count, wrong_count from user_question_state
        where user_id = ${userId} and canonical_question_id = ${finalItem.questionId}
      `;
      expect(state).toEqual({ correct_count: 1, wrong_count: 0 });
    } finally {
      gate.release();
      await gate.done;
      await Promise.allSettled(pending);
    }
  });

  it('rechecks blocked identity after waiting for the user lock', async () => {
    const sessionId = await createAnsweredSession(TODAY);
    const gate = await holdLock(
      async (tx) => await tx`select id from users where id = ${userId} for update`,
      async (tx) => await tx`update users set identity_status = 'blocked' where id = ${userId}`,
    );
    const pending: Promise<unknown>[] = [];
    try {
      const completion = track(pending, completeSession(userId, sessionId, NOW));
      await blockedBy(gate.pid, 'from "users"');
      gate.release();
      await gate.done;
      await expect(completion).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await storedSession(sessionId)).toEqual({
        study_date: TODAY,
        score: null,
        completed_at: null,
      });
      expect(await profile()).toEqual({ streak_days: 5, last_streak_date: '2026-10-03' });
    } finally {
      gate.release();
      await gate.done;
      await Promise.allSettled(pending);
    }
  });

  it('a deletion request rejects completion before and after the user is purged', async () => {
    const sessionId = await createAnsweredSession(TODAY);
    await requestDeletion(userId, NOW);
    await expect(completeSession(userId, sessionId, NOW)).rejects.toMatchObject({
      code: 'USER_DELETED',
    });
    expect(await storedSession(sessionId)).toEqual({
      study_date: TODAY,
      score: null,
      completed_at: null,
    });
    expect(await profile()).toEqual({ streak_days: 5, last_streak_date: '2026-10-03' });
    expect(await runPendingDeletionJobs(50, NOW)).toBe(1);
    await expect(completeSession(userId, sessionId, NOW)).rejects.toMatchObject({
      code: 'USER_DELETED',
    });
  });
});

describe('issue9: completion expiry behavior is unchanged', () => {
  it('yesterday completes before 01:00 KST and replays the same session after expiry', async () => {
    const sessionId = await createAnsweredSession(YESTERDAY);
    const first = await completeSession(userId, sessionId, new Date('2026-10-04T15:59:59Z'));
    expect(first).toMatchObject({
      session: { studyDate: YESTERDAY, score: 4 },
      streak: { days: 6, lastStreakDate: YESTERDAY },
      alreadyCompleted: false,
    });
    const replay = await completeSession(userId, sessionId, new Date('2026-10-04T16:00:00Z'));
    expect(replay).toEqual({ ...first, alreadyCompleted: true });
  });

  it('a fresh yesterday completion at 01:00 KST is rejected without changing streak', async () => {
    const sessionId = await createAnsweredSession(YESTERDAY);
    await expect(
      completeSession(userId, sessionId, new Date('2026-10-04T16:00:00Z')),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect(await storedSession(sessionId)).toEqual({
      study_date: YESTERDAY,
      score: null,
      completed_at: null,
    });
    expect(await profile()).toEqual({ streak_days: 5, last_streak_date: '2026-10-03' });
  });
});
