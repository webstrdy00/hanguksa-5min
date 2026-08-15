import { defineConfig } from 'vitest/config';

/**
 * DB 통합 테스트 전용 설정.
 *
 * 실제 PostgreSQL 이 필요하다. `pnpm db:up && pnpm db:migrate` 후에 실행한다.
 * 단위 테스트(`pnpm test`)와 분리해 두어야 DB 없이도 빠른 피드백을 받을 수 있고,
 * DB 테스트가 조용히 skip 되어 통과한 것처럼 보이는 일이 없다.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.db.test.ts'],
    setupFiles: ['./vitest.db.setup.ts'],
    restoreMocks: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // 같은 테이블을 truncate 하므로 파일 간 병렬 실행을 막는다.
    fileParallelism: false,
  },
});
