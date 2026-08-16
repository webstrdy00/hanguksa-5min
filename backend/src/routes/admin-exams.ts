import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { examScheduleAudits, examSchedules } from '../db/schema/exams.ts';
import { EXAM_STATUSES, EXAM_TYPES } from '../db/schema/enums.ts';
import { toExamWithDday, type ExamStatusValue } from '../domain/exams.ts';
import { authenticateAdmin, requireRole } from '../http/authenticate-admin.ts';
import { AppError } from '../http/errors.ts';
import {
  abortIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  replay,
} from '../http/idempotency.ts';
import type { AppInstance } from '../http/types.ts';
import { assertStudyDate } from '../lib/kst.ts';
import { writeAuditLog } from '../services/audit.ts';

/**
 * 관리자용 시험 일정 API (09 §3, 08 §1).
 *
 * 사용자 API 와 인증 경계를 분리한다 (공통 04 §2).
 * 모든 쓰기는 exam_schedule_audits 와 admin_audit_logs 에 남는다.
 * 일정이 바뀌면 앱 재배포 없이 D-day 가 갱신된다 (E2E P0).
 */

const createSchema = z.object({
  type: z.enum(EXAM_TYPES),
  round: z.number().int().positive().max(9999),
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceUrl: z.string().url().max(500),
  sourceVerifiedAt: z.string().datetime().optional(),
});

const updateSchema = z
  .object({
    examDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    status: z.enum(EXAM_STATUSES).optional(),
    sourceUrl: z.string().url().max(500).optional(),
    sourceVerifiedAt: z.string().datetime().optional(),
    // 변경 근거는 필수다. 왜 바꿨는지 없이 공식 일정을 고칠 수 없다 (07 §6).
    changeReason: z.string().min(2).max(300),
  })
  .refine(
    (value) =>
      value.examDate != null ||
      value.status != null ||
      value.sourceUrl != null ||
      value.sourceVerifiedAt != null,
    { message: '변경할 항목이 필요해요.' },
  );

const ADMIN_WRITE_ROLES = ['editor', 'admin'] as const;

export function registerAdminExamRoutes(app: AppInstance): void {
  const adminWriteRateLimit = app.rateLimit({
    max: 30,
    timeWindow: '1 minute',
    keyGenerator: (request) => `admin:${request.authenticatedAdmin?.id ?? request.ip}`,
  });

  app.get('/admin/v1/exams', { preHandler: authenticateAdmin }, async (request) => {
    requireRole(request, ['reviewer', ...ADMIN_WRITE_ROLES]);
    const now = new Date();

    const rows = await db
      .select({
        id: examSchedules.id,
        type: examSchedules.type,
        round: examSchedules.round,
        examDate: examSchedules.examDate,
        status: examSchedules.status,
        sourceUrl: examSchedules.sourceUrl,
        sourceVerifiedAt: examSchedules.sourceVerifiedAt,
      })
      .from(examSchedules)
      .orderBy(examSchedules.examDate);

    return {
      exams: rows.map((row) => ({
        ...toExamWithDday(
          {
            id: row.id,
            type: row.type,
            round: row.round,
            examDate: assertStudyDate(row.examDate),
            status: row.status as ExamStatusValue,
          },
          now,
        ),
        sourceUrl: row.sourceUrl,
        sourceVerifiedAt: row.sourceVerifiedAt,
      })),
    };
  });

  app.post(
    '/admin/v1/exams',
    { preHandler: [authenticateAdmin, adminWriteRateLimit] },
    async (request, reply) => {
      const admin = requireRole(request, ADMIN_WRITE_ROLES);

      const stored = await beginIdempotentRequest(
        request,
        { actorKey: `admin:${admin.id}`, adminUserId: admin.id },
        'POST /admin/v1/exams',
      );
      if (stored != null) {
        await replay(reply, stored);
        return reply;
      }

      try {
        const parsed = createSchema.safeParse(request.body);
        if (!parsed.success) {
          throw new AppError('INVALID_REQUEST', {
            details: {
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            },
          });
        }

        const examDate = assertStudyDate(parsed.data.examDate);
        const sourceVerifiedAt =
          parsed.data.sourceVerifiedAt == null
            ? new Date()
            : new Date(parsed.data.sourceVerifiedAt);

        const created = await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(examSchedules)
            .values({
              type: parsed.data.type,
              round: parsed.data.round,
              examDate,
              sourceUrl: parsed.data.sourceUrl,
              sourceVerifiedAt,
            })
            .onConflictDoNothing({ target: [examSchedules.type, examSchedules.round] })
            .returning({ id: examSchedules.id });

          const row = inserted[0];
          if (row == null) return null;

          await tx.insert(examScheduleAudits).values({
            examScheduleId: row.id,
            changedBy: admin.id,
            changeReason: '회차 등록',
            afterState: {
              type: parsed.data.type,
              round: parsed.data.round,
              examDate,
              status: 'scheduled',
            },
            sourceUrl: parsed.data.sourceUrl,
          });

          await writeAuditLog(tx, {
            actorAdminId: admin.id,
            action: 'update_exam_schedule',
            targetType: 'exam_schedule',
            targetId: row.id,
            detail: { operation: 'create', round: parsed.data.round, type: parsed.data.type },
          });

          return row.id;
        });

        if (created == null) {
          // 같은 종류/회차가 이미 있다. 중복 생성 대신 상태 충돌로 알린다.
          throw new AppError('STATE_CONFLICT', {
            userMessage: '이미 등록된 회차예요.',
            details: { type: parsed.data.type, round: parsed.data.round },
          });
        }

        const body = { id: created, type: parsed.data.type, round: parsed.data.round, examDate };
        await completeIdempotentRequest(request, { status: 201, body });

        return await reply.status(201).send(body);
      } catch (error) {
        // 실패한 요청이 키를 붙잡고 있으면 재시도가 영원히 막힌다.
        await abortIdempotentRequest(request);
        throw error;
      }
    },
  );

  app.patch(
    '/admin/v1/exams/:id',
    { preHandler: [authenticateAdmin, adminWriteRateLimit] },
    async (request) => {
      const admin = requireRole(request, ADMIN_WRITE_ROLES);

      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) {
        throw new AppError('INVALID_REQUEST', { details: { path: 'id' } });
      }

      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError('INVALID_REQUEST', {
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
      }

      const updated = await db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(examSchedules)
          .where(eq(examSchedules.id, params.data.id))
          .limit(1);

        if (before == null) return null;

        const patch: Record<string, unknown> = {};
        if (parsed.data.examDate != null) patch['examDate'] = assertStudyDate(parsed.data.examDate);
        if (parsed.data.status != null) patch['status'] = parsed.data.status;
        if (parsed.data.sourceUrl != null) patch['sourceUrl'] = parsed.data.sourceUrl;
        if (parsed.data.sourceVerifiedAt != null) {
          patch['sourceVerifiedAt'] = new Date(parsed.data.sourceVerifiedAt);
        }

        const [after] = await tx
          .update(examSchedules)
          .set(patch)
          .where(eq(examSchedules.id, params.data.id))
          .returning();

        await tx.insert(examScheduleAudits).values({
          examScheduleId: params.data.id,
          changedBy: admin.id,
          changeReason: parsed.data.changeReason,
          beforeState: {
            examDate: before.examDate,
            status: before.status,
            sourceUrl: before.sourceUrl,
          },
          afterState: {
            examDate: after?.examDate,
            status: after?.status,
            sourceUrl: after?.sourceUrl,
          },
          ...(parsed.data.sourceUrl == null ? {} : { sourceUrl: parsed.data.sourceUrl }),
        });

        await writeAuditLog(tx, {
          actorAdminId: admin.id,
          action: 'update_exam_schedule',
          targetType: 'exam_schedule',
          targetId: params.data.id,
          detail: { operation: 'update', changedFields: Object.keys(patch) },
        });

        return after ?? null;
      });

      if (updated == null) {
        throw new AppError('NOT_FOUND');
      }

      request.log.info({ examScheduleId: params.data.id }, 'exam_schedule_updated');

      return {
        exam: toExamWithDday(
          {
            id: updated.id,
            type: updated.type,
            round: updated.round,
            examDate: assertStudyDate(updated.examDate),
            status: updated.status as ExamStatusValue,
          },
          new Date(),
        ),
      };
    },
  );
}
