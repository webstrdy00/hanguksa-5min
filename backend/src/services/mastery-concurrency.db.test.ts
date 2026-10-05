import { eq } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.ts';
import { questionRevisions } from '../db/schema/content.ts';
import {
  createTestClient,
  fillSessionItems,
  insertAdmin,
  insertQuestion,
  insertRevision,
  insertSession,
  insertUser,
  truncateAll,
} from '../db/test-helpers.ts';
import { requestDeletion, runPendingDeletionJobs } from './deletion.ts';
import { enqueueMasteryRecalc, runNextMasteryRecalcJob } from './mastery-jobs.ts';
import { loadProgress, recalculateMastery } from './progress.ts';
import { submitAnswer } from './study-session.ts';

// Real PostgreSQL barriers: no mocked snapshots, timers, or service results.
// A trigger pauses a transaction after its snapshot/answer INSERT while pg_blocking_pids
// proves the competing operation is waiting on the shared user lock before release.
const BARRIER_KEY = 741119001;
const NOW = new Date('2026-10-05T03:00:00Z');
let sql: postgres.Sql;
let userId: string;
let sessionId: string;
let pool: { questionId: string; revisionId: string }[];

interface AreaCounts {
  era: string;
  topic: string;
  seen_count: number;
  correct_count: number;
}

async function ledger(): Promise<AreaCounts[]> {
  return await sql<AreaCounts[]>`
    select r.era, r.topic, count(*)::integer as seen_count,
           count(*) filter (where a.is_correct)::integer as correct_count
    from answers a
    join study_sessions s on s.id = a.session_id
    join study_session_items i
      on i.session_id = a.session_id and i.question_revision_id = a.question_revision_id
    join question_revisions r on r.id = a.question_revision_id
    where s.user_id = ${userId} and r.status <> 'voided'
    group by r.era, r.topic order by r.era, r.topic
  `;
}

async function assertConsistent(expectedSeen: number): Promise<void> {
  const expected = await ledger();
  expect(expected.reduce((sum, row) => sum + row.seen_count, 0)).toBe(expectedSeen);
  const actual = await sql<AreaCounts[]>`
    select era, topic, seen_count, correct_count from mastery
    where user_id = ${userId} order by era, topic
  `;
  expect([...actual]).toEqual([...expected]);
  const progress = await loadProgress(userId, NOW);
  expect(progress.summary.totalSeen).toBe(expectedSeen);
  expect(progress.summary.totalCorrect).toBe(
    expected.reduce((sum, row) => sum + row.correct_count, 0),
  );
}

async function assertSingleSubmission(slot: number): Promise<void> {
  const [answer] = await sql<{ count: number }[]>`
    select count(*)::integer as count from answers
    where session_id = ${sessionId} and question_revision_id = ${pool[slot]!.revisionId}
  `;
  expect(answer?.count).toBe(1);
  const [state] = await sql<{ correct_count: number; wrong_count: number }[]>`
    select correct_count, wrong_count from user_question_state
    where user_id = ${userId} and canonical_question_id = ${pool[slot]!.questionId}
  `;
  expect(state).toEqual({ correct_count: 1, wrong_count: 0 });
}

async function assertCompleted(jobId: string): Promise<void> {
  const [job] = await sql<
    { status: string; processed_users: number; total_users: number; last_error: string | null }[]
  >`
    select status, processed_users, total_users, last_error
    from mastery_recalc_jobs where id = ${jobId}
  `;
  expect(job).toEqual({
    status: 'completed',
    processed_users: 1,
    total_users: 1,
    last_error: null,
  });
  expect(await runNextMasteryRecalcJob(NOW)).toBeNull();
}

async function voidRevision(revisionId: string): Promise<string> {
  return await db.transaction(async (tx) => {
    await tx
      .update(questionRevisions)
      .set({ status: 'voided', statusReason: 'issue11 regression fixture' })
      .where(eq(questionRevisions.id, revisionId));
    const jobId = await enqueueMasteryRecalc(tx, {
      questionRevisionId: revisionId,
      reason: 'question_voided',
    });
    if (jobId == null) throw new Error('Missing regression job');
    return jobId;
  });
}

async function prepareSnapshot(validAnswers: number): Promise<string> {
  await submitAnswer(userId, sessionId, pool[0]!.revisionId, 0, NOW);
  if (validAnswers > 0) {
    // Wrong baseline exercises correct_count separately from seen_count.
    await submitAnswer(userId, sessionId, pool[1]!.revisionId, 1, NOW);
  }
  const jobId = await voidRevision(pool[0]!.revisionId);
  expect((await ledger()).reduce((sum, row) => sum + row.seen_count, 0)).toBe(validAnswers);
  return jobId;
}

async function installBarrier(table: 'mastery' | 'answers'): Promise<void> {
  await sql.unsafe(`
    create function issue11_pause_write() returns trigger language plpgsql as $$
    begin
      perform pg_advisory_xact_lock(${BARRIER_KEY});
      if TG_OP = 'DELETE' then return OLD; end if;
      return NEW;
    end $$
  `);
  await sql.unsafe(`
    create trigger issue11_pause_write
    ${table === 'mastery' ? 'before delete' : 'after insert'} on ${table}
    for each row execute function issue11_pause_write()
  `);
}

async function holdLock(
  acquire: (tx: postgres.TransactionSql) => Promise<unknown> = async (tx) =>
    await tx`select pg_advisory_xact_lock(${BARRIER_KEY})`,
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

// Attach rejection handlers immediately so cleanup can drain failed contenders, too.
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
  userId = await insertUser(sql, 'issue11-user');
  const reviewerId = await insertAdmin(sql);
  pool = [];
  for (let index = 0; index < 5; index += 1) {
    const questionId = await insertQuestion(sql);
    const revisionId = await insertRevision(sql, {
      questionId,
      reviewerId,
      era: index === 3 ? 'modern' : 'goryeo',
      topic: index === 3 ? 'culture' : 'politics',
    });
    pool.push({ questionId, revisionId });
  }
  await sql.begin(async (tx) => {
    sessionId = await insertSession(tx, userId, '2026-10-05');
    await fillSessionItems(tx, sessionId, pool);
  });
});

afterEach(async () => {
  await sql`drop trigger if exists issue11_pause_write on mastery`;
  await sql`drop trigger if exists issue11_pause_write on answers`;
  await sql`drop function if exists issue11_pause_write()`;
});

const snapshotCases = [
  { validAnswers: 0, answerSlot: 2, area: 'same area' },
  { validAnswers: 1, answerSlot: 2, area: 'same area' },
  { validAnswers: 1, answerSlot: 3, area: 'different area' },
];

describe('issue11: mastery replacement and incremental writes serialize per user', () => {
  for (const { validAnswers, answerSlot, area } of snapshotCases) {
    it(`recalc first: ${validAnswers} valid snapshot, ${area}, duplicate submit`, async () => {
      const jobId = await prepareSnapshot(validAnswers);
      await installBarrier('mastery');
      const gate = await holdLock();
      const pending: Promise<unknown>[] = [];
      try {
        const job = track(pending, runNextMasteryRecalcJob(NOW));
        // Even the empty valid snapshot has the original void mastery row to DELETE.
        const recalcPid = await blockedBy(gate.pid, 'delete from "mastery"');
        const first = track(
          pending,
          submitAnswer(userId, sessionId, pool[answerSlot]!.revisionId, 0, NOW),
        );
        const second = track(
          pending,
          submitAnswer(userId, sessionId, pool[answerSlot]!.revisionId, 0, NOW),
        );
        await blockedBy(recalcPid, 'from "users"');
        expect((await ledger()).reduce((sum, row) => sum + row.seen_count, 0)).toBe(validAnswers);
        gate.release();
        await gate.done;
        expect(await job).toEqual({ jobId, status: 'completed', processedUsers: 1 });
        const submitted = await Promise.all([first, second]);
        expect(submitted.map((result) => result.replayed).sort()).toEqual([false, true]);
        await assertSingleSubmission(answerSlot);
        await assertConsistent(validAnswers + 1);
        await assertCompleted(jobId);
        await expect(
          submitAnswer(userId, sessionId, pool[answerSlot]!.revisionId, 1, NOW),
        ).rejects.toMatchObject({ code: 'ANSWER_ALREADY_SUBMITTED' });
        await assertConsistent(validAnswers + 1);
      } finally {
        gate.release();
        await gate.done;
        await Promise.allSettled(pending);
      }
    });

    it(`answer first: ${validAnswers} valid snapshot, ${area}, duplicate submit`, async () => {
      const jobId = await prepareSnapshot(validAnswers);
      await installBarrier('answers');
      const gate = await holdLock();
      const pending: Promise<unknown>[] = [];
      try {
        const first = track(
          pending,
          submitAnswer(userId, sessionId, pool[answerSlot]!.revisionId, 0, NOW),
        );
        const answerPid = await blockedBy(gate.pid, 'insert into "answers"');
        const job = track(pending, runNextMasteryRecalcJob(NOW));
        await blockedBy(answerPid, 'from "users"');
        const second = track(
          pending,
          submitAnswer(userId, sessionId, pool[answerSlot]!.revisionId, 0, NOW),
        );
        // The first answer is still uncommitted. Recalc must not snapshot it yet.
        expect((await ledger()).reduce((sum, row) => sum + row.seen_count, 0)).toBe(validAnswers);
        gate.release();
        await gate.done;
        expect((await first).replayed).toBe(false);
        expect((await second).replayed).toBe(true);
        expect(await job).toEqual({ jobId, status: 'completed', processedUsers: 1 });
        await assertSingleSubmission(answerSlot);
        await assertConsistent(validAnswers + 1);
        await assertCompleted(jobId);
      } finally {
        gate.release();
        await gate.done;
        await Promise.allSettled(pending);
      }
    });
  }

  it.each(['answer first', 'recalc first'] as const)('serial control: %s', async (order) => {
    const jobId = await prepareSnapshot(1);
    if (order === 'answer first') {
      await submitAnswer(userId, sessionId, pool[2]!.revisionId, 0, NOW);
      await runNextMasteryRecalcJob(NOW);
    } else {
      await runNextMasteryRecalcJob(NOW);
      await submitAnswer(userId, sessionId, pool[2]!.revisionId, 0, NOW);
    }
    await assertConsistent(2);
    await assertCompleted(jobId);
  });
});

describe('issue11: void and deletion boundaries', () => {
  it('void first: audit/replay survives but no review or mastery increment is added', async () => {
    const jobId = await voidRevision(pool[0]!.revisionId);
    const answer = await submitAnswer(userId, sessionId, pool[0]!.revisionId, 0, NOW);
    expect(answer.replayed).toBe(false);
    expect(answer.answeredCount).toBe(0);
    expect(answer.validCount).toBe(4);
    const [audit] = await sql<{ count: number }[]>`
      select count(*)::integer as count from answers where session_id = ${sessionId}
    `;
    expect(audit?.count).toBe(1);
    const states = await sql`select * from user_question_state where user_id = ${userId}`;
    expect(states).toHaveLength(0);
    await assertConsistent(0);
    expect(await runNextMasteryRecalcJob(NOW)).toEqual({
      jobId,
      status: 'completed',
      processedUsers: 1,
    });
    expect((await submitAnswer(userId, sessionId, pool[0]!.revisionId, 0, NOW)).replayed).toBe(
      true,
    );
    await expect(
      submitAnswer(userId, sessionId, pool[0]!.revisionId, 1, NOW),
    ).rejects.toMatchObject({
      code: 'ANSWER_ALREADY_SUBMITTED',
    });
    await assertConsistent(0);
    await assertCompleted(jobId);
  });

  it('answer first: concurrent void waits for revision lock and its job removes the increment', async () => {
    await installBarrier('answers');
    const gate = await holdLock();
    const pending: Promise<unknown>[] = [];
    try {
      const answer = track(pending, submitAnswer(userId, sessionId, pool[0]!.revisionId, 0, NOW));
      const answerPid = await blockedBy(gate.pid, 'insert into "answers"');
      const voided = track(pending, voidRevision(pool[0]!.revisionId));
      await blockedBy(answerPid, 'update "question_revisions"');
      gate.release();
      await gate.done;
      expect((await answer).replayed).toBe(false);
      const jobId = await voided;
      expect(await runNextMasteryRecalcJob(NOW)).toEqual({
        jobId,
        status: 'completed',
        processedUsers: 1,
      });
      await assertConsistent(0);
      await assertCompleted(jobId);
      const [audit] = await sql<{ count: number }[]>`
        select count(*)::integer as count from answers where session_id = ${sessionId}
      `;
      expect(audit?.count).toBe(1);
    } finally {
      gate.release();
      await gate.done;
      await Promise.allSettled(pending);
    }
  });

  it('publish order: canonical lock is acquired before revision so retirement cannot deadlock', async () => {
    // Match admin publishing's canonical FOR UPDATE -> old revision UPDATE sequence.
    const gate = await holdLock(
      async (tx) => await tx`select id from questions where id = ${pool[0]!.questionId} for update`,
      async (tx) =>
        await tx`
        update question_revisions set status = 'retired', status_reason = 'new revision'
        where id = ${pool[0]!.revisionId}
      `,
    );
    const pending: Promise<unknown>[] = [];
    try {
      const answer = track(pending, submitAnswer(userId, sessionId, pool[0]!.revisionId, 0, NOW));
      await blockedBy(gate.pid, 'for key share');
      gate.release();
      await gate.done;
      expect((await answer).replayed).toBe(false);
      await assertConsistent(1); // Retired revisions remain valid for an existing session.
    } finally {
      gate.release();
      await gate.done;
      await Promise.allSettled(pending);
    }
  });

  it('delete first: skip a deleted user before touching rows the deletion worker removes', async () => {
    await prepareSnapshot(1);
    await requestDeletion(userId, NOW);
    const before = await sql`select * from mastery where user_id = ${userId}`;
    expect(await recalculateMastery(userId, NOW)).toEqual([]);
    const after = await sql`select * from mastery where user_id = ${userId}`;
    expect([...after]).toEqual([...before]);
    await installBarrier('mastery');
    const gate = await holdLock();
    const pending: Promise<unknown>[] = [];
    try {
      const deletion = track(pending, runPendingDeletionJobs(50, NOW));
      // Worker already removed answers/sessions/state but has not reached DELETE users.
      await blockedBy(gate.pid, 'delete from "mastery"');
      // Acquiring the user lock is safe only if the deleted guard returns before any mastery write.
      expect(await recalculateMastery(userId, NOW)).toEqual([]);
      await expect(
        submitAnswer(userId, sessionId, pool[2]!.revisionId, 0, NOW),
      ).rejects.toMatchObject({
        code: 'USER_DELETED',
      });
      gate.release();
      await gate.done;
      expect(await deletion).toBe(1);
      expect(await recalculateMastery(userId, NOW)).toEqual([]);
      await assertConsistent(0);
    } finally {
      gate.release();
      await gate.done;
      await Promise.allSettled(pending);
    }
  });

  it('recalc first: deletion request waits for user lock, then removes all derived rows', async () => {
    const jobId = await prepareSnapshot(1);
    await installBarrier('mastery');
    const gate = await holdLock();
    const pending: Promise<unknown>[] = [];
    try {
      const job = track(pending, runNextMasteryRecalcJob(NOW));
      const recalcPid = await blockedBy(gate.pid, 'delete from "mastery"');
      const deletion = track(pending, requestDeletion(userId, NOW));
      await blockedBy(recalcPid, 'from "users"');
      gate.release();
      await gate.done;
      expect(await job).toEqual({ jobId, status: 'completed', processedUsers: 1 });
      await deletion;
      expect(await runPendingDeletionJobs(50, NOW)).toBe(1);
      expect(await recalculateMastery(userId, NOW)).toEqual([]);
      await assertConsistent(0);
    } finally {
      gate.release();
      await gate.done;
      await Promise.allSettled(pending);
    }
  });
});
