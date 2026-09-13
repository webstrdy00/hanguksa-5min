import { and, eq, inArray, sql } from 'drizzle-orm';
import { revokedFingerprint } from '../auth/fingerprint.ts';
import { db } from '../db/client.ts';
import { questionReports } from '../db/schema/content.ts';
import { users } from '../db/schema/identity.ts';
import { answers, mastery, studySessions, userQuestionState } from '../db/schema/learning.ts';
import { deletionJobs, idempotencyKeys, notificationConsents } from '../db/schema/ops.ts';
import { AppError } from '../http/errors.ts';
import { logger } from '../observability/logger.ts';

/**
 * 계정 삭제 / 탈퇴 (공통 04 §5, 09 §6, 하드게이트 P0).
 *
 * 핵심 원칙:
 * - UI 에서 버튼을 눌렀다고 완료로 처리하지 않는다. 서버가 deletion_job 상태를 만든다.
 * - 운영 DB → 캐시 → 푸시 대상 → 파생 데이터 → 백업 소거 주기까지 **데이터 맵으로 추적**한다.
 * - 삭제 성공 후 토큰/세션/푸시 대상을 즉시 무효화한다.
 * - 콘텐츠 편집 이력과 신고 사유는 개인정보와 분리된 운영 기록이라 보존한다 (09 §6).
 *
 * 이 파일은 "무엇을 지웠는지"를 단계별로 기록한다. 기록이 없으면 삭제를 증명할 수 없다.
 */

/** 삭제 이행 단계. 공통 04 §5 의 데이터 맵과 1:1 로 맞춘다. */
export const DELETION_STEPS = [
  'operational_db',
  'cache',
  'push_target',
  'derived_data',
  'backup_lifecycle',
] as const;

export type DeletionStep = (typeof DELETION_STEPS)[number];

export interface DeletionStepRecord {
  step: DeletionStep;
  status: 'completed' | 'scheduled';
  /** 지운 행 수. 감사에서 "정말 지웠는지" 확인하는 근거다. */
  removed?: number;
  note?: string;
  at: string;
}

/**
 * 삭제 요청을 접수한다.
 *
 * 요청 즉시 하는 일:
 *  1. 식별키 매핑 폐기 (같은 anonKey 로 다시 들어와도 이 계정에 닿지 못한다)
 *  2. identity_status = deleted (토큰이 살아 있어도 다음 요청에서 403)
 *  3. deletion_job 생성
 *
 * 실제 데이터 파기는 배치가 이어서 처리한다.
 */
export async function requestDeletion(
  userId: string,
  now = new Date(),
): Promise<{ jobId: string }> {
  const jobId = await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, identityStatus: users.identityStatus })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user == null) throw new AppError('NOT_FOUND');
    if (user.identityStatus === 'deleted') {
      throw new AppError('STATE_CONFLICT', { userMessage: '이미 삭제 요청이 접수됐어요.' });
    }

    // 공통 04 §4: 삭제 시 매핑을 폐기한다.
    await tx
      .update(users)
      .set({
        anonKeyFingerprint: revokedFingerprint(userId),
        anonKeyCiphertext: null,
        anonKeyKeyVersion: null,
        identityStatus: 'deleted',
        deletedAt: now,
      })
      .where(eq(users.id, userId));

    const [job] = await tx
      .insert(deletionJobs)
      .values({
        subjectUserId: userId,
        status: 'requested',
        requestedAt: now,
        steps: [],
      })
      .returning({ id: deletionJobs.id });

    return job?.id ?? null;
  });

  if (jobId == null) throw new AppError('INTERNAL_ERROR');

  // 어떤 사용자인지 로그에 남기지 않는다. job 으로만 추적한다.
  logger.info({ jobId }, 'deletion_requested');

  return { jobId };
}

/**
 * 삭제 이행 배치.
 *
 * 멱등하다. 중간에 실패해도 다시 돌리면 같은 상태가 된다.
 */
export async function runPendingDeletionJobs(limit = 50, now = new Date()): Promise<number> {
  const pending = await db
    .select({ id: deletionJobs.id, subjectUserId: deletionJobs.subjectUserId })
    .from(deletionJobs)
    .where(inArray(deletionJobs.status, ['requested', 'failed', 'in_progress']))
    .orderBy(deletionJobs.updatedAt, deletionJobs.id)
    .limit(limit);

  let processed = 0;

  for (const job of pending) {
    try {
      if (await executeDeletion(job.id, job.subjectUserId, now)) processed += 1;
    } catch {
      await db
        .update(deletionJobs)
        .set({
          status: 'failed',
          lastError: 'DELETION_EXECUTION_FAILED',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deletionJobs.id, job.id),
            inArray(deletionJobs.status, ['requested', 'failed', 'in_progress']),
          ),
        );

      logger.error({ jobId: job.id }, 'deletion_job_failed');
    }
  }

  return processed;
}

/** 개인정보 대신 집계 수치만 운영 알림으로 전달한다. */
export async function getDeletionQueueHealth(now = new Date()): Promise<{
  failed: number;
  overdue: number;
}> {
  const cutoff = new Date(now.getTime() - 15 * 60_000);
  const [row] = await db
    .select({
      failed: sql<number>`count(*) filter (where ${deletionJobs.status} = 'failed')::integer`,
      overdue: sql<number>`count(*) filter (where ${deletionJobs.requestedAt} <= ${cutoff.toISOString()}::timestamptz)::integer`,
    })
    .from(deletionJobs)
    .where(inArray(deletionJobs.status, ['requested', 'failed', 'in_progress']));
  return { failed: row?.failed ?? 0, overdue: row?.overdue ?? 0 };
}

async function executeDeletion(jobId: string, userId: string, now: Date): Promise<boolean> {
  const steps: DeletionStepRecord[] = [];

  const processed = await db.transaction(async (tx) => {
    // 여러 인스턴스와 재기동에서도 같은 삭제를 중복 실행하지 않는다.
    const [job] = await tx
      .select({ status: deletionJobs.status })
      .from(deletionJobs)
      .where(eq(deletionJobs.id, jobId))
      .for('update', { skipLocked: true });
    if (job == null || job.status === 'completed') return false;
    await tx
      .update(deletionJobs)
      .set({ status: 'in_progress', startedAt: now, updatedAt: now, lastError: null })
      .where(eq(deletionJobs.id, jobId));
    // ---------------------------------------------------------------------
    // 1. 운영 DB — 학습 개인 데이터 (09 §6: 삭제 요청 시 제거)
    // ---------------------------------------------------------------------
    const sessions = await tx
      .select({ id: studySessions.id })
      .from(studySessions)
      .where(eq(studySessions.userId, userId));

    // 세션마다 DELETE 를 돌리면 세션 수만큼 쿼리가 나간다.
    // 오래 사용한 계정일수록 느려지므로 한 번에 지운다.
    const sessionIds = sessions.map((session) => session.id);
    const removedAnswers =
      sessionIds.length === 0
        ? []
        : await tx
            .delete(answers)
            .where(inArray(answers.sessionId, sessionIds))
            .returning({ id: answers.id });
    const answerCount = removedAnswers.length;

    // 세션을 지우면 항목은 cascade 로 함께 사라진다.
    // 항목만 먼저 지우면 "세션당 5문항" deferred 제약에 걸린다.
    const removedSessions = await tx
      .delete(studySessions)
      .where(eq(studySessions.userId, userId))
      .returning({ id: studySessions.id });

    const removedState = await tx
      .delete(userQuestionState)
      .where(eq(userQuestionState.userId, userId))
      .returning({ userId: userQuestionState.userId });

    const removedMastery = await tx
      .delete(mastery)
      .where(eq(mastery.userId, userId))
      .returning({ userId: mastery.userId });

    steps.push({
      step: 'operational_db',
      status: 'completed',
      removed: answerCount + removedSessions.length + removedState.length + removedMastery.length,
      note: 'answers, study_sessions(+items), user_question_state, mastery',
      at: new Date().toISOString(),
    });

    // ---------------------------------------------------------------------
    // 2. 캐시 — V1 은 별도 캐시 계층이 없다 (공통 02 §1 "캐시는 필요 시에만")
    // ---------------------------------------------------------------------
    steps.push({
      step: 'cache',
      status: 'completed',
      removed: 0,
      note: 'V1 은 별도 캐시 계층 없음. 도입 시 이 단계에 무효화를 추가한다.',
      at: new Date().toISOString(),
    });

    // ---------------------------------------------------------------------
    // 3. 푸시 대상 — 동의 정보와 발송 대상 제거 (공통 04 §5 "푸시 대상 즉시 무효화")
    // ---------------------------------------------------------------------
    const removedConsents = await tx
      .delete(notificationConsents)
      .where(eq(notificationConsents.userId, userId))
      .returning({ userId: notificationConsents.userId });

    steps.push({
      step: 'push_target',
      status: 'completed',
      removed: removedConsents.length,
      note: 'notification_consents 제거. 이후 발송 대상에서 제외된다.',
      at: new Date().toISOString(),
    });

    // ---------------------------------------------------------------------
    // 4. 파생 데이터 — 멱등 키, 신고에 남은 사용자 흔적 익명화
    // ---------------------------------------------------------------------
    const removedIdempotency = await tx
      .delete(idempotencyKeys)
      .where(eq(idempotencyKeys.userId, userId))
      .returning({ id: idempotencyKeys.id });

    // 신고 자체는 콘텐츠 품질 데이터로 남기되, 신고자와 작성 원문은 지운다 (09 §6).
    const anonymizedReports = await tx
      .update(questionReports)
      .set({ reporterUserId: null, detail: null })
      .where(eq(questionReports.reporterUserId, userId))
      .returning({ id: questionReports.id });

    steps.push({
      step: 'derived_data',
      status: 'completed',
      removed: removedIdempotency.length + anonymizedReports.length,
      note: 'idempotency_keys 삭제, question_reports 신고자/본문 익명화',
      at: new Date().toISOString(),
    });

    // ---------------------------------------------------------------------
    // 5. 사용자 행 파기
    // ---------------------------------------------------------------------
    await tx.delete(users).where(eq(users.id, userId));

    // ---------------------------------------------------------------------
    // 6. 백업 — 보관 주기가 지나야 소거된다. 예약으로 기록한다 (공통 04 §4).
    // ---------------------------------------------------------------------
    steps.push({
      step: 'backup_lifecycle',
      status: 'scheduled',
      note: '백업 보관 주기 종료 시 소거. 실제 보관일은 공급자 확정 후 기입한다(AGENTS.md §9 #2).',
      at: new Date().toISOString(),
    });

    await tx
      .update(deletionJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
        steps: sql`${JSON.stringify(steps)}::jsonb`,
      })
      .where(eq(deletionJobs.id, jobId));
    return true;
  });

  if (processed) logger.info({ jobId, steps: steps.length }, 'deletion_completed');
  return processed;
}

export interface DeletionStatusView {
  jobId: string;
  status: string;
  requestedAt: string;
  completedAt: string | null;
  steps: DeletionStepRecord[];
}

/** 삭제 진행 상황 조회. 운영자가 "정말 지워졌는지" 확인하는 경로다. */
export async function getDeletionStatus(jobId: string): Promise<DeletionStatusView> {
  const [job] = await db
    .select({
      id: deletionJobs.id,
      status: deletionJobs.status,
      requestedAt: deletionJobs.requestedAt,
      completedAt: deletionJobs.completedAt,
      steps: deletionJobs.steps,
    })
    .from(deletionJobs)
    .where(eq(deletionJobs.id, jobId))
    .limit(1);

  if (job == null) throw new AppError('NOT_FOUND');

  return {
    jobId: job.id,
    status: job.status,
    requestedAt: job.requestedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    steps: (job.steps ?? []) as DeletionStepRecord[],
  };
}
