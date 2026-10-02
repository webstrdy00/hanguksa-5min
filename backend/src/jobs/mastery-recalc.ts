import process from 'node:process';
import { closeDb } from '../db/client.ts';
import { runPendingMasteryRecalcJobs } from '../services/mastery-jobs.ts';

/**
 * 숙련도 재계산 배치 (07 §9, 09 §5).
 *
 *   pnpm --filter @hanguksa/backend jobs:mastery
 *
 * void 처리로 쌓인 재계산 작업을 처리한다.
 * 서버는 기동 시 및 이전 배치 종료 30초 후 자동 처리한다.
 * 이 CLI는 운영자가 같은 큐를 수동 처리할 때 사용한다.
 * 재실행해도 안전하다. 작업 처리는 멱등하다.
 */
async function main(): Promise<void> {
  const results = await runPendingMasteryRecalcJobs();

  if (results.length === 0) {
    console.log('[mastery-recalc] 처리할 작업이 없습니다.');
    return;
  }

  const failed = results.filter((result) => result.status === 'failed');

  for (const result of results) {
    console.log(
      `[mastery-recalc] job=${result.jobId} status=${result.status} users=${result.processedUsers}`,
    );
  }

  console.log(`[mastery-recalc] 완료 ${results.length - failed.length} / 실패 ${failed.length}`);

  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('[mastery-recalc] 실패');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
