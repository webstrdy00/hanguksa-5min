import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { examSchedules } from '../db/schema/exams.ts';
import { users } from '../db/schema/identity.ts';
import {
  buildGoalView,
  isSelectable,
  listUpcomingExams,
  todayInKst,
  type ExamScheduleView,
  type ExamStatusValue,
} from '../domain/exams.ts';
import { authenticate, requireUser } from '../http/authenticate.ts';
import { AppError } from '../http/errors.ts';
import type { AppInstance } from '../http/types.ts';
import { assertStudyDate } from '../lib/kst.ts';

/**
 * 사용자용 시험 일정 API.
 *
 * GET   /v1/exams          인증 필요. 선택 가능한 회차 + 내 목표의 D-day
 * PATCH /v1/profile/goal   인증 필요. 목표 급수/회차 변경 (08 §2)
 *
 * D-day 와 만료 판정은 전부 서버가 한다. 클라이언트가 보낸 날짜/상태를 신뢰하지 않는다.
 */

const goalPatchSchema = z
  .object({
    targetGrade: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    targetExamId: z.string().uuid().optional(),
  })
  .refine((value) => value.targetGrade != null || value.targetExamId != null, {
    message: '변경할 항목이 필요해요.',
  });

function toView(row: {
  id: string;
  type: string;
  round: number;
  examDate: string;
  status: string;
}): ExamScheduleView {
  return {
    id: row.id,
    type: row.type,
    round: row.round,
    examDate: assertStudyDate(row.examDate),
    status: row.status as ExamStatusValue,
  };
}

export function registerExamRoutes(app: AppInstance): void {
  app.get('/v1/exams', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request);
    const now = new Date();

    const rows = await db
      .select({
        id: examSchedules.id,
        type: examSchedules.type,
        round: examSchedules.round,
        examDate: examSchedules.examDate,
        status: examSchedules.status,
      })
      .from(examSchedules)
      // V1 은 심화만 다룬다 (07 §1).
      .where(eq(examSchedules.type, 'advanced'));

    const upcoming = listUpcomingExams(rows.map(toView), now);

    const [profile] = await db
      .select({ targetGrade: users.targetGrade, targetExamId: users.targetExamId })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    const targetRow =
      profile?.targetExamId == null
        ? null
        : (rows.find((row) => row.id === profile.targetExamId) ?? null);

    const goal = buildGoalView(
      profile?.targetGrade ?? null,
      targetRow == null ? null : toView(targetRow),
      now,
    );

    return {
      // 클라이언트가 자기 시계로 날짜를 계산하지 않도록 서버 KST 기준 오늘을 함께 준다 (09 §1).
      today: todayInKst(now),
      exams: upcoming,
      goal,
    };
  });

  app.patch('/v1/profile/goal', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request);
    const parsed = goalPatchSchema.safeParse(request.body);

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

    const now = new Date();
    const update: { targetGrade?: number; targetExamId?: string } = {};

    if (parsed.data.targetGrade != null) {
      update.targetGrade = parsed.data.targetGrade;
    }

    if (parsed.data.targetExamId != null) {
      const [exam] = await db
        .select({
          id: examSchedules.id,
          type: examSchedules.type,
          round: examSchedules.round,
          examDate: examSchedules.examDate,
          status: examSchedules.status,
        })
        .from(examSchedules)
        .where(eq(examSchedules.id, parsed.data.targetExamId))
        .limit(1);

      if (exam == null) {
        throw new AppError('NOT_FOUND');
      }

      // 지난 회차나 변경/취소된 회차를 목표로 삼을 수 없다 (08 §4).
      if (!isSelectable(toView(exam), now)) {
        throw new AppError('STATE_CONFLICT', {
          userMessage: '이 회차는 지금 선택할 수 없어요. 다른 회차를 골라주세요.',
          details: { examStatus: exam.status },
        });
      }

      update.targetExamId = exam.id;
    }

    // 과거 학습 기록은 건드리지 않는다. 목표 값만 바꾼다 (08 §2).
    await db.update(users).set(update).where(eq(users.id, user.id));

    const [profile] = await db
      .select({ targetGrade: users.targetGrade, targetExamId: users.targetExamId })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    const targetRows =
      profile?.targetExamId == null
        ? []
        : await db
            .select({
              id: examSchedules.id,
              type: examSchedules.type,
              round: examSchedules.round,
              examDate: examSchedules.examDate,
              status: examSchedules.status,
            })
            .from(examSchedules)
            .where(
              and(
                eq(examSchedules.id, profile.targetExamId),
                inArray(examSchedules.type, ['advanced', 'basic']),
              ),
            )
            .limit(1);

    const goal = buildGoalView(
      profile?.targetGrade ?? null,
      targetRows[0] == null ? null : toView(targetRows[0]),
      now,
    );

    request.log.info({ changedGrade: update.targetGrade != null }, 'profile_goal_updated');

    return { goal };
  });
}
