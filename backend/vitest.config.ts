import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // DB 및 비공개 문항 검증은 각각 test:db / test:content로 실행한다.
    exclude: ['src/**/*.db.test.ts', 'src/**/*.content.test.ts', 'node_modules/**'],
    setupFiles: ['./vitest.setup.ts'],
    restoreMocks: true,
    // Windows 콜드 캐시에서 Fastify 플러그인 로딩이 느려 기본 5s/10s 로는 부족하다.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
