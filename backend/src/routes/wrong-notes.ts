import { z } from 'zod';
import { ERAS } from '../db/schema/enums.ts';
import { authenticate, requireUser } from '../http/authenticate.ts';
import { AppError } from '../http/errors.ts';
import type { AppInstance } from '../http/types.ts';
import { listWrongNotes, recordReview } from '../services/wrong-notes.ts';

/**
 * 오답노트 API (03 §3, 02 UX).
 *
 * GET  /v1/wrong-notes                 미복습/복습완료 + 시대 필터
 * POST /v1/wrong-notes/:id/review      복습 기록 (id = canonical question id)
 */

const listQuerySchema = z.object({
  era: z.enum(ERAS).optional(),
  status: z.enum(['unreviewed', 'reviewed', 'all']).default('all'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const paramsSchema = z.object({ id: z.string().uuid() });

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

export function registerWrongNoteRoutes(app: AppInstance): void {
  app.get('/v1/wrong-notes', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request);

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) throw invalidRequest(parsed.error);

    return await listWrongNotes(user.id, parsed.data);
  });

  app.post('/v1/wrong-notes/:id/review', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request);

    const params = paramsSchema.safeParse(request.params);
    if (!params.success) throw invalidRequest(params.error);

    const result = await recordReview(user.id, params.data.id, new Date());

    // 어떤 문항을 복습했는지는 개인화 데이터다. 문항 원문을 로그에 남기지 않는다 (07 §7).
    request.log.info({ reviewed: result.reviewed }, 'wrong_note_reviewed');

    return result;
  });
}
