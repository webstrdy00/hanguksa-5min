import { z } from 'zod';
import { NOTICE_TYPES, REPORT_REASONS, REPORT_STATUSES } from '../db/schema/enums.ts';
import { authenticateAdmin, requireRole } from '../http/authenticate-admin.ts';
import { authenticate, requireUser } from '../http/authenticate.ts';
import { AppError } from '../http/errors.ts';
import type { AppInstance } from '../http/types.ts';
import {
  createReport,
  listPublishedCorrections,
  listReports,
  publishCorrection,
  updateReportStatus,
} from '../services/content-ops.ts';
import {
  FLAG_QUESTION_REPORT,
  assertEnabled,
  listFlags,
  setFlag,
} from '../services/feature-flags.ts';
import { runPendingMasteryRecalcJobs } from '../services/mastery-jobs.ts';

/**
 * 오류 제보 · 정정 안내 · 기능 플래그 (07 §9, 08 §2, 공통 02 §7).
 *
 * 사용자:  POST /v1/questions/:revisionId/report
 *          GET  /v1/corrections
 *          GET  /v1/feature-flags
 * 관리자:  GET   /admin/v1/reports
 *          PATCH /admin/v1/reports/:id
 *          POST  /admin/v1/questions/:id/correction
 *          PATCH /admin/v1/feature-flags/:key
 *          POST  /admin/v1/jobs/mastery-recalc/run
 */

const WRITE_ROLES = ['editor', 'admin'] as const;
const READ_ROLES = ['reviewer', 'editor', 'admin'] as const;

const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  // 사용자가 고른 답은 받지 않는다 (08 §2). 보충 설명만 선택적으로 받는다.
  detail: z.string().min(2).max(500).optional(),
});

const reportListSchema = z.object({
  status: z.enum(REPORT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const reportPatchSchema = z.object({ status: z.enum(REPORT_STATUSES) });

const correctionSchema = z.object({
  noticeType: z.enum(NOTICE_TYPES),
  message: z.string().min(2).max(500),
  fromRevisionId: z.string().uuid().optional(),
  toRevisionId: z.string().uuid().optional(),
});

const flagPatchSchema = z.object({ enabled: z.boolean() });

function invalidRequest(error: z.ZodError): AppError {
  return new AppError('INVALID_REQUEST', {
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
}

export function registerOpsRoutes(app: AppInstance): void {
  /** 공통 04 §3: 오류 신고 사용자당 10회/시간 */
  const reportRateLimit = app.rateLimit({
    max: 10,
    timeWindow: '1 hour',
    keyGenerator: (request) => `report:${request.authenticatedUser?.id ?? request.ip}`,
  });

  // ---------------------------------------------------------------------------
  // 사용자
  // ---------------------------------------------------------------------------
  app.post(
    '/v1/questions/:id/report',
    { preHandler: [authenticate, reportRateLimit] },
    async (request, reply) => {
      const user = requireUser(request);
      await assertEnabled(FLAG_QUESTION_REPORT, '지금은 오류 제보를 받을 수 없어요.');

      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw invalidRequest(params.error);

      const parsed = reportSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      const result = await createReport({
        userId: user.id,
        questionRevisionId: params.data.id,
        reason: parsed.data.reason,
        ...(parsed.data.detail == null ? {} : { detail: parsed.data.detail }),
      });

      // 신고 사유는 운영 지표다. 사용자가 쓴 본문은 로그에 남기지 않는다.
      request.log.info({ reason: parsed.data.reason, merged: result.merged }, 'question_report');

      return await reply.status(result.merged ? 200 : 201).send(result);
    },
  );

  app.get('/v1/corrections', { preHandler: authenticate }, async (request) => {
    requireUser(request);
    return { corrections: await listPublishedCorrections(50) };
  });

  app.get('/v1/feature-flags', { preHandler: authenticate }, async (request) => {
    requireUser(request);
    return { flags: await listFlags() };
  });

  // ---------------------------------------------------------------------------
  // 관리자
  // ---------------------------------------------------------------------------
  app.get('/admin/v1/reports', { preHandler: authenticateAdmin }, async (request) => {
    requireRole(request, READ_ROLES);

    const parsed = reportListSchema.safeParse(request.query);
    if (!parsed.success) throw invalidRequest(parsed.error);

    return await listReports(parsed.data);
  });

  app.patch('/admin/v1/reports/:id', { preHandler: authenticateAdmin }, async (request) => {
    const admin = requireRole(request, WRITE_ROLES);

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw invalidRequest(params.error);

    const parsed = reportPatchSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);

    return await updateReportStatus({
      reportId: params.data.id,
      status: parsed.data.status,
      adminId: admin.id,
    });
  });

  app.post(
    '/admin/v1/questions/:id/correction',
    { preHandler: authenticateAdmin },
    async (request, reply) => {
      const admin = requireRole(request, WRITE_ROLES);

      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw invalidRequest(params.error);

      const parsed = correctionSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      const created = await publishCorrection({
        questionId: params.data.id,
        noticeType: parsed.data.noticeType,
        message: parsed.data.message,
        adminId: admin.id,
        ...(parsed.data.fromRevisionId == null
          ? {}
          : { fromRevisionId: parsed.data.fromRevisionId }),
        ...(parsed.data.toRevisionId == null ? {} : { toRevisionId: parsed.data.toRevisionId }),
      });

      return await reply.status(201).send(created);
    },
  );

  app.patch('/admin/v1/feature-flags/:key', { preHandler: authenticateAdmin }, async (request) => {
    const admin = requireRole(request, WRITE_ROLES);

    const params = z.object({ key: z.string().min(1).max(100) }).safeParse(request.params);
    if (!params.success) throw invalidRequest(params.error);

    const parsed = flagPatchSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);

    const flag = await setFlag({
      key: params.data.key,
      enabled: parsed.data.enabled,
      adminId: admin.id,
    });

    request.log.warn({ key: flag.key, enabled: flag.enabled }, 'feature_flag_changed');
    return flag;
  });

  /** 재계산 배치 수동 실행. 정기 실행은 CLI(jobs:mastery)로 돌린다. */
  app.post(
    '/admin/v1/jobs/mastery-recalc/run',
    { preHandler: authenticateAdmin },
    async (request) => {
      requireRole(request, WRITE_ROLES);
      const results = await runPendingMasteryRecalcJobs();
      return { processedJobs: results.length, results };
    },
  );
}
