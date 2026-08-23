import { and, count, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { correctionNotices, questionReports, questionRevisions } from '../db/schema/content.ts';
import type { NoticeType, ReportReason, ReportStatus } from '../db/schema/enums.ts';
import { AppError } from '../http/errors.ts';
import { writeAuditLog } from './audit.ts';

/**
 * 오류 제보와 정정 안내 (08 §2, 07 §9, 06 백로그 P0).
 *
 * 개인정보 규칙:
 * - 08 §2: 사용자가 무엇을 골랐는지는 저장하지 않는다. reason 과 선택적 설명만 받는다.
 * - 공통 04 §4: 신고 내용을 Analytics/외부로 내보내지 않는다.
 */

export interface ReportResult {
  id: string;
  status: ReportStatus;
  /** 이미 접수된 신고를 합친 경우 true (공통 04 §3 "중복 신고 합치기") */
  merged: boolean;
}

export async function createReport(params: {
  userId: string;
  questionRevisionId: string;
  reason: ReportReason;
  detail?: string;
}): Promise<ReportResult> {
  const [revision] = await db
    .select({ id: questionRevisions.id })
    .from(questionRevisions)
    .where(eq(questionRevisions.id, params.questionRevisionId))
    .limit(1);

  if (revision == null) throw new AppError('NOT_FOUND');

  // 같은 사용자가 같은 문항을 다시 신고하면 새로 만들지 않고 기존 접수를 돌려준다.
  const [existing] = await db
    .select({ id: questionReports.id, status: questionReports.status })
    .from(questionReports)
    .where(
      and(
        eq(questionReports.questionRevisionId, params.questionRevisionId),
        eq(questionReports.reporterUserId, params.userId),
        eq(questionReports.status, 'open'),
      ),
    )
    .limit(1);

  if (existing != null) {
    return { id: existing.id, status: existing.status as ReportStatus, merged: true };
  }

  const [created] = await db
    .insert(questionReports)
    .values({
      questionRevisionId: params.questionRevisionId,
      reporterUserId: params.userId,
      reason: params.reason,
      ...(params.detail == null ? {} : { detail: params.detail }),
    })
    .returning({ id: questionReports.id, status: questionReports.status });

  if (created == null) throw new AppError('INTERNAL_ERROR');

  return { id: created.id, status: created.status as ReportStatus, merged: false };
}

export interface AdminReportItem {
  id: string;
  questionRevisionId: string;
  questionId: string;
  revision: number;
  revisionStatus: string;
  reason: string;
  detail: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export async function listReports(query: {
  status?: ReportStatus | undefined;
  page: number;
  limit: number;
}): Promise<{ items: AdminReportItem[]; page: number; limit: number; total: number }> {
  const where = query.status == null ? undefined : eq(questionReports.status, query.status);
  const offset = (query.page - 1) * query.limit;

  const [rows, totalRow] = await Promise.all([
    db
      .select({
        id: questionReports.id,
        questionRevisionId: questionReports.questionRevisionId,
        questionId: questionRevisions.questionId,
        revision: questionRevisions.revision,
        revisionStatus: questionRevisions.status,
        reason: questionReports.reason,
        detail: questionReports.detail,
        status: questionReports.status,
        createdAt: questionReports.createdAt,
        resolvedAt: questionReports.resolvedAt,
      })
      .from(questionReports)
      .innerJoin(questionRevisions, eq(questionRevisions.id, questionReports.questionRevisionId))
      .where(where)
      .orderBy(desc(questionReports.createdAt))
      .limit(query.limit)
      .offset(offset),
    db.select({ value: count() }).from(questionReports).where(where),
  ]);

  return {
    items: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    })),
    page: query.page,
    limit: query.limit,
    total: totalRow[0]?.value ?? 0,
  };
}

const RESOLVED_STATUSES = new Set(['resolved', 'rejected']);

export async function updateReportStatus(params: {
  reportId: string;
  status: ReportStatus;
  adminId: string;
}): Promise<{ id: string; status: string }> {
  const [current] = await db
    .select({ id: questionReports.id, status: questionReports.status })
    .from(questionReports)
    .where(eq(questionReports.id, params.reportId))
    .limit(1);

  if (current == null) throw new AppError('NOT_FOUND');

  if (RESOLVED_STATUSES.has(current.status)) {
    throw new AppError('STATE_CONFLICT', { userMessage: '이미 처리된 신고예요.' });
  }

  const resolved = RESOLVED_STATUSES.has(params.status);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(questionReports)
      .set({
        status: params.status,
        ...(resolved
          ? { resolvedBy: params.adminId, resolvedAt: new Date() }
          : { resolvedBy: null, resolvedAt: null }),
      })
      .where(eq(questionReports.id, params.reportId))
      .returning({ id: questionReports.id, status: questionReports.status });

    await writeAuditLog(tx, {
      actorAdminId: params.adminId,
      action: 'resolve_report',
      targetType: 'question_report',
      targetId: params.reportId,
      detail: { from: current.status, to: params.status },
    });

    return row;
  });

  if (updated == null) throw new AppError('INTERNAL_ERROR');
  return updated;
}

/**
 * 정정 안내 (07 §9).
 * 과거 문항 수정 사실을 사용자에게 알려야 할 때 기록하고 앱 내 공지로 노출한다.
 */
export async function publishCorrection(params: {
  questionId: string;
  fromRevisionId?: string;
  toRevisionId?: string;
  noticeType: NoticeType;
  message: string;
  adminId: string;
}): Promise<{ id: string }> {
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(correctionNotices)
      .values({
        questionId: params.questionId,
        noticeType: params.noticeType,
        message: params.message,
        publishedAt: new Date(),
        createdBy: params.adminId,
        ...(params.fromRevisionId == null ? {} : { fromRevisionId: params.fromRevisionId }),
        ...(params.toRevisionId == null ? {} : { toRevisionId: params.toRevisionId }),
      })
      .returning({ id: correctionNotices.id });

    await writeAuditLog(tx, {
      actorAdminId: params.adminId,
      action: 'publish_correction',
      targetType: 'correction_notice',
      targetId: row?.id ?? params.questionId,
      detail: { noticeType: params.noticeType },
    });

    return row;
  });

  if (created == null) throw new AppError('INTERNAL_ERROR');
  return created;
}

export interface CorrectionNoticeView {
  id: string;
  questionId: string;
  noticeType: string;
  message: string;
  publishedAt: string;
}

/** 사용자에게 보여줄 정정 안내. 발행된 것만 나간다. */
export async function listPublishedCorrections(limit: number): Promise<CorrectionNoticeView[]> {
  const rows = await db
    .select({
      id: correctionNotices.id,
      questionId: correctionNotices.questionId,
      noticeType: correctionNotices.noticeType,
      message: correctionNotices.message,
      publishedAt: correctionNotices.publishedAt,
    })
    .from(correctionNotices)
    .where(isNotNull(correctionNotices.publishedAt))
    .orderBy(desc(correctionNotices.publishedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    questionId: row.questionId,
    noticeType: row.noticeType,
    message: row.message,
    publishedAt: (row.publishedAt ?? new Date()).toISOString(),
  }));
}
