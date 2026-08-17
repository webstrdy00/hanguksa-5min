import { and, asc, count, desc, eq, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { ABILITIES, ERAS, QUESTION_STATUSES, RIGHTS_TYPES, TOPICS } from '../db/schema/enums.ts';
import type { Era, QuestionStatus, Topic } from '../db/schema/enums.ts';
import { questionRevisions, questions } from '../db/schema/content.ts';
import {
  assignsReviewer,
  canTransition,
  evaluateCoverage,
  missingPublishRequirements,
  nextRevisionNumber,
  requiresStatusReason,
} from '../domain/questions.ts';
import { authenticateAdmin, requireRole } from '../http/authenticate-admin.ts';
import { AppError } from '../http/errors.ts';
import {
  abortIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  replay,
} from '../http/idempotency.ts';
import type { AppInstance } from '../http/types.ts';
import { writeAuditLog } from '../services/audit.ts';
import type { AuditAction } from '../db/schema/enums.ts';

/**
 * 문항 CMS (관리자 전용).
 *
 * 핵심 규칙:
 * - 내용 수정은 없다. 항상 새 revision 을 발행한다 (08 §1, 09 §2).
 * - revision 번호와 상태 전이 가능 여부는 서버가 정한다.
 * - published 필수 메타가 없으면 발행할 수 없다 (07 §4~5).
 * - 모든 상태 전이는 감사 로그에 남는다 (공통 04 §2).
 */

/** 읽기는 검수자도 가능하다. */
const READ_ROLES = ['reviewer', 'editor', 'admin'] as const;
/** 문항 작성과 발행은 편집 권한이 필요하다. */
const WRITE_ROLES = ['editor', 'admin'] as const;
/** 검수 단계 전이는 검수자도 할 수 있다. */
const REVIEW_ROLES = ['reviewer', 'editor', 'admin'] as const;

/**
 * revision 내용 스키마.
 *
 * reviewerId / reviewedAt 은 받지 않는다. 승인 시점에 서버가 채운다.
 * revision 번호도 받지 않는다. 서버가 계산한다.
 */
const revisionContentSchema = z.object({
  era: z.enum(ERAS),
  topic: z.enum(TOPICS),
  ability: z.enum(ABILITIES),
  difficulty: z.number().int().min(1).max(3),
  prompt: z.string().min(5).max(2000),
  // 심화 시험은 5지 선택형이다 (02 UX).
  choices: z.array(z.string().min(1).max(500)).length(5),
  correctIndex: z.number().int().min(0).max(4),
  explanation: z.string().min(5).max(2000),
  wrongAnswerNotes: z.array(z.string().min(1).max(500)).max(5).optional(),
  memoryKeyword: z.string().min(1).max(100).optional(),
  sourceRefs: z
    .array(z.object({ title: z.string().min(1).max(200), url: z.string().url().max(500) }))
    .max(10)
    .optional(),
  sourceAccessedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  rightsType: z.enum(RIGHTS_TYPES).optional(),
  rightsNote: z.string().max(500).optional(),
  // AI 초안 사용 기록. 정확한 포맷은 미결정(AGENTS.md §9 #13)이라 느슨하게 받되 크기를 제한한다.
  aiGenerationMeta: z
    .object({
      model: z.string().max(100),
      promptVersion: z.string().max(50),
      generatedAt: z.string().datetime(),
    })
    .optional(),
});

const statusPatchSchema = z.object({
  status: z.enum(QUESTION_STATUSES),
  statusReason: z.string().min(2).max(300).optional(),
});

const listQuerySchema = z.object({
  era: z.enum(ERAS).optional(),
  topic: z.enum(TOPICS).optional(),
  status: z.enum(QUESTION_STATUSES).optional(),
  difficulty: z.coerce.number().int().min(1).max(3).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const AUDIT_BY_STATUS: Partial<Record<QuestionStatus, AuditAction>> = {
  review: 'submit_question_review',
  approved: 'approve_question',
  published: 'publish_question',
  retired: 'retire_question',
  voided: 'void_question',
};

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

/** 요청 본문을 DB insert 값으로 바꾼다. 받지 않은 값은 넣지 않는다. */
function toRevisionValues(
  content: z.infer<typeof revisionContentSchema>,
  questionId: string,
  revision: number,
  createdBy: string,
) {
  return {
    questionId,
    revision,
    status: 'draft' as const,
    era: content.era,
    topic: content.topic,
    ability: content.ability,
    difficulty: content.difficulty,
    prompt: content.prompt,
    choices: content.choices,
    correctIndex: content.correctIndex,
    explanation: content.explanation,
    rightsType: content.rightsType ?? 'unknown',
    sourceRefs: content.sourceRefs ?? [],
    createdBy,
    ...(content.wrongAnswerNotes == null ? {} : { wrongAnswerNotes: content.wrongAnswerNotes }),
    ...(content.memoryKeyword == null ? {} : { memoryKeyword: content.memoryKeyword }),
    ...(content.sourceAccessedAt == null ? {} : { sourceAccessedAt: content.sourceAccessedAt }),
    ...(content.rightsNote == null ? {} : { rightsNote: content.rightsNote }),
    ...(content.aiGenerationMeta == null ? {} : { aiGenerationMeta: content.aiGenerationMeta }),
  };
}

export function registerAdminQuestionRoutes(app: AppInstance): void {
  const writeRateLimit = app.rateLimit({
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (request) => `admin-cms:${request.authenticatedAdmin?.id ?? request.ip}`,
  });

  // ---------------------------------------------------------------------------
  // 1. 문항 생성 (canonical question + revision 1)
  // ---------------------------------------------------------------------------
  app.post(
    '/admin/v1/questions',
    { preHandler: [authenticateAdmin, writeRateLimit] },
    async (request, reply) => {
      const admin = requireRole(request, WRITE_ROLES);

      const stored = await beginIdempotentRequest(
        request,
        { actorKey: `admin:${admin.id}`, adminUserId: admin.id },
        'POST /admin/v1/questions',
      );
      if (stored != null) {
        await replay(reply, stored);
        return reply;
      }

      try {
        const parsed = revisionContentSchema.safeParse(request.body);
        if (!parsed.success) throw invalidRequest(parsed.error);

        const created = await db.transaction(async (tx) => {
          const [question] = await tx
            .insert(questions)
            .values({ createdBy: admin.id })
            .returning({ id: questions.id });

          if (question == null) throw new AppError('INTERNAL_ERROR');

          const [revision] = await tx
            .insert(questionRevisions)
            .values(toRevisionValues(parsed.data, question.id, 1, admin.id))
            .returning({ id: questionRevisions.id, revision: questionRevisions.revision });

          await writeAuditLog(tx, {
            actorAdminId: admin.id,
            action: 'create_revision',
            targetType: 'question_revision',
            targetId: revision?.id ?? question.id,
            detail: { questionId: question.id, revision: 1, era: parsed.data.era },
          });

          return { questionId: question.id, revisionId: revision?.id, revision: 1 };
        });

        await completeIdempotentRequest(request, { status: 201, body: created });
        return await reply.status(201).send(created);
      } catch (error) {
        await abortIdempotentRequest(request);
        throw error;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // 2. 새 revision 발행 (내용 수정의 유일한 경로)
  // ---------------------------------------------------------------------------
  app.post(
    '/admin/v1/questions/:id/revisions',
    { preHandler: [authenticateAdmin, writeRateLimit] },
    async (request, reply) => {
      const admin = requireRole(request, WRITE_ROLES);

      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw invalidRequest(params.error);

      const stored = await beginIdempotentRequest(
        request,
        { actorKey: `admin:${admin.id}`, adminUserId: admin.id },
        'POST /admin/v1/questions/:id/revisions',
      );
      if (stored != null) {
        await replay(reply, stored);
        return reply;
      }

      try {
        const parsed = revisionContentSchema.safeParse(request.body);
        if (!parsed.success) throw invalidRequest(parsed.error);

        const created = await db.transaction(async (tx) => {
          const [question] = await tx
            .select({ id: questions.id })
            .from(questions)
            .where(eq(questions.id, params.data.id))
            .limit(1);

          if (question == null) return null;

          // revision 번호는 서버가 정한다. 요청값을 신뢰하지 않는다.
          const [current] = await tx
            .select({ maxRevision: max(questionRevisions.revision) })
            .from(questionRevisions)
            .where(eq(questionRevisions.questionId, question.id));

          const revision = nextRevisionNumber(current?.maxRevision ?? null);

          const [inserted] = await tx
            .insert(questionRevisions)
            .values(toRevisionValues(parsed.data, question.id, revision, admin.id))
            .returning({ id: questionRevisions.id });

          await writeAuditLog(tx, {
            actorAdminId: admin.id,
            action: 'create_revision',
            targetType: 'question_revision',
            targetId: inserted?.id ?? question.id,
            detail: { questionId: question.id, revision },
          });

          return { questionId: question.id, revisionId: inserted?.id, revision };
        });

        if (created == null) throw new AppError('NOT_FOUND');

        await completeIdempotentRequest(request, { status: 201, body: created });
        return await reply.status(201).send(created);
      } catch (error) {
        await abortIdempotentRequest(request);
        throw error;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // 3. 상태 전이
  // ---------------------------------------------------------------------------
  app.patch(
    '/admin/v1/revisions/:id/status',
    { preHandler: [authenticateAdmin, writeRateLimit] },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw invalidRequest(params.error);

      const parsed = statusPatchSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);

      const target = parsed.data.status;

      // 발행/폐기는 편집 권한, 검수 단계는 검수자도 가능하다.
      const admin =
        target === 'review' || target === 'approved'
          ? requireRole(request, REVIEW_ROLES)
          : requireRole(request, WRITE_ROLES);

      if (requiresStatusReason(target) && parsed.data.statusReason == null) {
        throw new AppError('INVALID_REQUEST', {
          userMessage: '이 상태로 바꾸려면 사유가 필요해요.',
          details: { field: 'statusReason' },
        });
      }

      const result = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(questionRevisions)
          .where(eq(questionRevisions.id, params.data.id))
          .limit(1);

        if (current == null) return { kind: 'not_found' as const };

        const from = current.status as QuestionStatus;

        if (!canTransition(from, target)) {
          return { kind: 'invalid_transition' as const, from };
        }

        if (target === 'published') {
          // 같은 문항을 두 관리자가 동시에 발행하면 partial unique 인덱스에 걸린다.
          // canonical question 행을 잠가 발행을 직렬화한다. 나중 요청이 앞 발행본을 정상적으로 내린다.
          await tx
            .select({ id: questions.id })
            .from(questions)
            .where(eq(questions.id, current.questionId))
            .for('update');

          const missing = missingPublishRequirements({
            sourceRefs: current.sourceRefs,
            sourceAccessedAt: current.sourceAccessedAt,
            reviewerId: current.reviewerId,
            reviewedAt: current.reviewedAt,
            rightsType: current.rightsType,
          });

          if (missing.length > 0) {
            return { kind: 'missing_meta' as const, missing };
          }

          // 한 문항에 published 는 하나뿐이다. 기존 발행본을 같은 트랜잭션에서 내린다.
          await tx
            .update(questionRevisions)
            .set({
              status: 'retired',
              statusReason: '새 revision 발행으로 대체',
              statusChangedAt: new Date(),
            })
            .where(
              and(
                eq(questionRevisions.questionId, current.questionId),
                eq(questionRevisions.status, 'published'),
              ),
            );
        }

        const patch: Record<string, unknown> = {
          status: target,
          statusChangedAt: new Date(),
        };
        if (parsed.data.statusReason != null) patch['statusReason'] = parsed.data.statusReason;

        // 검수자는 서버가 기록한다. 클라이언트가 보낸 값을 쓰지 않는다 (07 §5).
        if (assignsReviewer(target)) {
          patch['reviewerId'] = admin.id;
          patch['reviewedAt'] = new Date();
        }

        const [updated] = await tx
          .update(questionRevisions)
          .set(patch)
          .where(eq(questionRevisions.id, params.data.id))
          .returning({
            id: questionRevisions.id,
            questionId: questionRevisions.questionId,
            revision: questionRevisions.revision,
            status: questionRevisions.status,
          });

        const action = AUDIT_BY_STATUS[target];
        if (action != null) {
          await writeAuditLog(tx, {
            actorAdminId: admin.id,
            action,
            targetType: 'question_revision',
            targetId: params.data.id,
            detail: {
              questionId: current.questionId,
              revision: current.revision,
              from,
              to: target,
            },
          });
        }

        return { kind: 'ok' as const, revision: updated };
      });

      if (result.kind === 'not_found') {
        throw new AppError('NOT_FOUND');
      }
      if (result.kind === 'invalid_transition') {
        throw new AppError('STATE_CONFLICT', {
          userMessage: '지금 상태에서는 그렇게 바꿀 수 없어요.',
          details: { from: result.from, to: target },
        });
      }
      if (result.kind === 'missing_meta') {
        // 출처/검수/권리 메타 없이는 발행할 수 없다 (07 §4).
        throw new AppError('PUBLISH_REQUIREMENTS_MISSING', {
          details: { missing: result.missing },
        });
      }

      request.log.info({ to: target }, 'question_revision_status_changed');
      return { revision: result.revision };
    },
  );

  // ---------------------------------------------------------------------------
  // 4. 목록 (문항별 최신 revision 기준)
  // ---------------------------------------------------------------------------
  app.get('/admin/v1/questions', { preHandler: authenticateAdmin }, async (request) => {
    requireRole(request, READ_ROLES);

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) throw invalidRequest(parsed.error);

    const latest = db
      .selectDistinctOn([questionRevisions.questionId], {
        questionId: questionRevisions.questionId,
        revisionId: questionRevisions.id,
        revision: questionRevisions.revision,
        status: questionRevisions.status,
        era: questionRevisions.era,
        topic: questionRevisions.topic,
        ability: questionRevisions.ability,
        difficulty: questionRevisions.difficulty,
        prompt: questionRevisions.prompt,
        createdAt: questionRevisions.createdAt,
      })
      .from(questionRevisions)
      .orderBy(questionRevisions.questionId, desc(questionRevisions.revision))
      .as('latest');

    const filters = [];
    if (parsed.data.era != null) filters.push(eq(latest.era, parsed.data.era));
    if (parsed.data.topic != null) filters.push(eq(latest.topic, parsed.data.topic));
    if (parsed.data.status != null) filters.push(eq(latest.status, parsed.data.status));
    if (parsed.data.difficulty != null) filters.push(eq(latest.difficulty, parsed.data.difficulty));

    const where = filters.length === 0 ? undefined : and(...filters);
    const offset = (parsed.data.page - 1) * parsed.data.limit;

    const [rows, totalRow] = await Promise.all([
      db
        .select()
        .from(latest)
        .where(where)
        .orderBy(desc(latest.createdAt))
        .limit(parsed.data.limit)
        .offset(offset),
      db.select({ value: count() }).from(latest).where(where),
    ]);

    return {
      items: rows,
      page: parsed.data.page,
      limit: parsed.data.limit,
      total: totalRow[0]?.value ?? 0,
    };
  });

  // ---------------------------------------------------------------------------
  // 5. 단일 문항의 revision 이력 전체
  // ---------------------------------------------------------------------------
  app.get('/admin/v1/questions/:id', { preHandler: authenticateAdmin }, async (request) => {
    requireRole(request, READ_ROLES);

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw invalidRequest(params.error);

    const [question] = await db
      .select({ id: questions.id, createdAt: questions.createdAt })
      .from(questions)
      .where(eq(questions.id, params.data.id))
      .limit(1);

    if (question == null) throw new AppError('NOT_FOUND');

    const revisions = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.questionId, question.id))
      .orderBy(asc(questionRevisions.revision));

    return { question, revisions };
  });

  // ---------------------------------------------------------------------------
  // 6. 커버리지 리포트 (09 §5 콘텐츠 게이트)
  // ---------------------------------------------------------------------------
  app.get('/admin/v1/coverage', { preHandler: authenticateAdmin }, async (request) => {
    requireRole(request, READ_ROLES);

    const rows = await db
      .select({
        era: questionRevisions.era,
        topic: questionRevisions.topic,
        value: count(),
      })
      .from(questionRevisions)
      .where(eq(questionRevisions.status, 'published'))
      .groupBy(questionRevisions.era, questionRevisions.topic);

    const report = evaluateCoverage(
      rows.map((row) => ({
        era: row.era as Era,
        topic: row.topic as Topic,
        count: Number(row.value),
      })),
    );

    // published 인데 필수 메타가 비어 있는 건은 DB CHECK 상 0이어야 한다. 확인용으로 함께 센다.
    const [metaGap] = await db
      .select({ value: count() })
      .from(questionRevisions)
      .where(
        and(
          eq(questionRevisions.status, 'published'),
          sql`(jsonb_array_length(${questionRevisions.sourceRefs}) = 0
               or ${questionRevisions.reviewerId} is null
               or ${questionRevisions.sourceAccessedAt} is null
               or ${questionRevisions.rightsType} = 'unknown')`,
        ),
      );

    return { ...report, metadataGaps: Number(metaGap?.value ?? 0) };
  });
}
