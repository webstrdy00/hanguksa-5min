import { authenticate, requireUser } from '../http/authenticate.ts';
import type { AppInstance } from '../http/types.ts';
import { loadProgress } from '../services/progress.ts';

/**
 * 학습현황 API (08 §2, 02 UX).
 *
 * GET /v1/progress — 시대별 최근 정답률 + 취약 라벨 + 최근 7일 + 연속 학습일
 *
 * 07 §3 위반 금지:
 * - seen_count < 5 인 영역은 퍼센트를 아예 내려보내지 않는다(accuracyPercent = null).
 * - 내부 모델 점수(smoothed_accuracy)를 노출하지 않는다.
 * - 합격 확률로 변환하지 않는다.
 */
export function registerProgressRoutes(app: AppInstance): void {
  app.get('/v1/progress', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request);
    return await loadProgress(user.id, new Date());
  });
}
