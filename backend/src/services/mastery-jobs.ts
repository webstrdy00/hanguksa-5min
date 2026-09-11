import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { RecalcReason } from '../db/schema/enums.ts';
import { answers, studySessions } from '../db/schema/learning.ts';
import { masteryRecalcJobs } from '../db/schema/ops.ts';
import { logger } from '../observability/logger.ts';
import { recalculateMastery } from './progress.ts';

/**
 * 숙련도 재계산 작업 (07 §9, 09 §5).
 *
 * void 처리는 사용자 통계를 바꾸지만, 그 문항을 푼 사용자가 많을 수 있다.
 * void 트랜잭션 안에서 전부 재계산하면 관리자 요청이 느려지고 실패 시 되돌리기 어렵다.
 * 그래서 작업만 남기고 배치가 처리한다.
 *
 * 문항 오류로 사용자를 벌하지 않는다는 원칙(09 §2)에 따라
 * 재계산은 집계만 고치고 학습 완료 기록이나 streak 는 건드리지 않는다.
 */

/** void 처리 시 호출한다. 같은 트랜잭션에서 작업을 남긴다. */
export async function enqueueMasteryRecalc(
  executor: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  params: { questionRevisionId: string; reason: RecalcReason; requestedBy?: string },
): Promise<string | null> {
  const [job] = await executor
    .insert(masteryRecalcJobs)
    .values({
      questionRevisionId: params.questionRevisionId,
      reason: params.reason,
      status: 'pending',
      ...(params.requestedBy == null ? {} : { requestedBy: params.requestedBy }),
    })
    .returning({ id: masteryRecalcJobs.id });

  return job?.id ?? null;
}

export interface JobRunResult {
  jobId: string;
  processedUsers: number;
  status: 'completed' | 'failed';
}

/** 해당 revision 을 실제로 푼 사용자 목록. 재계산 대상이다. */
async function findAffectedUsers(questionRevisionId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: studySessions.userId })
    .from(answers)
    .innerJoin(studySessions, eq(studySessions.id, answers.sessionId))
    .where(eq(answers.questionRevisionId, questionRevisionId));

  return rows.map((row) => row.userId);
}

/**
 * 대기 중인 작업을 하나 처리한다.
 *
 * 여러 워커가 동시에 돌아도 하나만 집도록 status 조건부 UPDATE 로 선점한다.
 */
export async function runNextMasteryRecalcJob(now = new Date()): Promise<JobRunResult | null> {
  const [claimed] = await db
    .update(masteryRecalcJobs)
    .set({ status: 'running', startedAt: now, updatedAt: now })
    .where(
      eq(
        masteryRecalcJobs.id,
        sql`(select id from mastery_recalc_jobs where status = 'pending' order by created_at limit 1 for update skip locked)`,
      ),
    )
    .returning({
      id: masteryRecalcJobs.id,
      questionRevisionId: masteryRecalcJobs.questionRevisionId,
    });

  if (claimed == null) return null;

  try {
    const userIds = await findAffectedUsers(claimed.questionRevisionId);

    await db
      .update(masteryRecalcJobs)
      .set({ totalUsers: userIds.length, updatedAt: now })
      .where(eq(masteryRecalcJobs.id, claimed.id));

    let processed = 0;
    for (const userId of userIds) {
      await recalculateMastery(userId, now);
      processed += 1;

      // 중간에 죽어도 어디까지 했는지 남긴다. 재실행은 멱등하므로 처음부터 돌려도 안전하다.
      await db
        .update(masteryRecalcJobs)
        .set({ processedUsers: processed, updatedAt: new Date() })
        .where(eq(masteryRecalcJobs.id, claimed.id));
    }

    await db
      .update(masteryRecalcJobs)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(masteryRecalcJobs.id, claimed.id));

    logger.info({ jobId: claimed.id, processedUsers: processed }, 'mastery_recalc_job_completed');

    return { jobId: claimed.id, processedUsers: processed, status: 'completed' };
  } catch (error) {
    await db
      .update(masteryRecalcJobs)
      .set({
        status: 'failed',
        lastError: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
        updatedAt: new Date(),
      })
      .where(eq(masteryRecalcJobs.id, claimed.id));

    logger.error({ err: error, jobId: claimed.id }, 'mastery_recalc_job_failed');

    return { jobId: claimed.id, processedUsers: 0, status: 'failed' };
  }
}

/** 대기 중인 작업을 모두 처리한다. 배치 진입점. */
export async function runPendingMasteryRecalcJobs(limit = 50): Promise<JobRunResult[]> {
  const results: JobRunResult[] = [];

  for (let index = 0; index < limit; index += 1) {
    const result = await runNextMasteryRecalcJob();
    if (result == null) break;
    results.push(result);
  }

  return results;
}

/** 실패한 작업을 다시 대기 상태로 돌린다. 운영 복구용. */
export async function retryFailedMasteryRecalcJobs(): Promise<number> {
  const rows = await db
    .update(masteryRecalcJobs)
    .set({ status: 'pending', lastError: null, updatedAt: new Date() })
    .where(and(eq(masteryRecalcJobs.status, 'failed')))
    .returning({ id: masteryRecalcJobs.id });

  return rows.length;
}
