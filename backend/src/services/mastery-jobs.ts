import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { RecalcReason } from '../db/schema/enums.ts';
import { answers, studySessions } from '../db/schema/learning.ts';
import { masteryRecalcJobs } from '../db/schema/ops.ts';
import { logger } from '../observability/logger.ts';
import { recalculateMastery } from './progress.ts';

type MasteryJobTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  executor: MasteryJobTransaction | typeof db,
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
async function findAffectedUsers(
  tx: MasteryJobTransaction,
  questionRevisionId: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: studySessions.userId })
    .from(answers)
    .innerJoin(studySessions, eq(studySessions.id, answers.sessionId))
    .where(eq(answers.questionRevisionId, questionRevisionId))
    .orderBy(studySessions.userId);

  return rows.map((row) => row.userId);
}

/** 잠긴 작업도 포함한다. failed 는 운영자가 명시적으로 재시도할 때만 처리한다. */
export async function getMasteryQueuePending(): Promise<boolean> {
  const [job] = await db
    .select({ id: masteryRecalcJobs.id })
    .from(masteryRecalcJobs)
    .where(inArray(masteryRecalcJobs.status, ['pending', 'running']))
    .limit(1);

  return job != null;
}

/**
 * 대기 중이거나 이전 워커가 남긴 running 작업을 하나 처리한다.
 *
 * 선점부터 완료까지 같은 트랜잭션의 행 잠금을 유지한다. 프로세스가 죽으면
 * 선점도 롤백되므로 다른 워커/CLI 가 다시 처리할 수 있다.
 * 배포 시 이 잠금 규약을 쓰지 않는 구버전 워커를 반드시 먼저 중지해야 한다.
 */
export async function runNextMasteryRecalcJob(now = new Date()): Promise<JobRunResult | null> {
  const result = await db.transaction<JobRunResult | null>(async (tx) => {
    const [claimed] = await tx
      .select({
        id: masteryRecalcJobs.id,
        questionRevisionId: masteryRecalcJobs.questionRevisionId,
      })
      .from(masteryRecalcJobs)
      .where(inArray(masteryRecalcJobs.status, ['pending', 'running']))
      .orderBy(masteryRecalcJobs.createdAt, masteryRecalcJobs.id)
      .limit(1)
      .for('update', { skipLocked: true });

    if (claimed == null) return null;

    await tx
      .update(masteryRecalcJobs)
      .set({
        status: 'running',
        startedAt: now,
        completedAt: null,
        totalUsers: 0,
        processedUsers: 0,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(masteryRecalcJobs.id, claimed.id));

    try {
      // SQL 실패도 failed 로 기록할 수 있도록 savepoint 만 되돌린다.
      // 선점 잠금은 savepoint 밖에 있어 실패 처리 중에도 다른 워커가 가져가지 못한다.
      const processed = await tx.transaction(async (processingTx) => {
        const userIds = await findAffectedUsers(processingTx, claimed.questionRevisionId);

        await processingTx
          .update(masteryRecalcJobs)
          .set({ totalUsers: userIds.length, updatedAt: now })
          .where(eq(masteryRecalcJobs.id, claimed.id));

        let processedUsers = 0;
        for (const userId of userIds) {
          // 바깥 트랜잭션은 작업 행만 잠근다. 사용자/학습 행까지 잠그면 별도 연결의
          // 재계산/삭제와 순환 대기하므로 기존 원장 → 사용자 잠금 순서를 유지한다.
          // 사용자별 재계산은 따로 커밋된다. 작업 커밋 전 죽으면 이미 처리한 사용자도
          // 다시 계산하지만 답안 이력으로 전량 교체하므로 멱등하다.
          await recalculateMastery(userId, now);
          processedUsers += 1;

          await processingTx
            .update(masteryRecalcJobs)
            .set({ processedUsers, updatedAt: new Date() })
            .where(eq(masteryRecalcJobs.id, claimed.id));
        }

        const completedAt = new Date();
        await processingTx
          .update(masteryRecalcJobs)
          .set({ status: 'completed', completedAt, updatedAt: completedAt })
          .where(eq(masteryRecalcJobs.id, claimed.id));

        return processedUsers;
      });

      return { jobId: claimed.id, processedUsers: processed, status: 'completed' };
    } catch {
      await tx
        .update(masteryRecalcJobs)
        .set({ status: 'failed', lastError: 'MASTERY_RECALC_FAILED', updatedAt: new Date() })
        .where(eq(masteryRecalcJobs.id, claimed.id));

      return { jobId: claimed.id, processedUsers: 0, status: 'failed' };
    }
  });

  if (result?.status === 'completed') {
    logger.info(
      { jobId: result.jobId, processedUsers: result.processedUsers },
      'mastery_recalc_job_completed',
    );
  } else if (result?.status === 'failed') {
    logger.error(
      { jobId: result.jobId, code: 'MASTERY_RECALC_FAILED' },
      'mastery_recalc_job_failed',
    );
  }

  return result;
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
