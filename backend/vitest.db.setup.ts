import process from 'node:process';

/**
 * DB 통합 테스트 setup.
 *
 * 단위 테스트와 달리 진짜 PostgreSQL 이 필요하다.
 * 로컬에서는 backend/.env 를, CI 에서는 주입된 환경변수를 사용한다.
 * 값이 없으면 조용히 skip 하지 않고 즉시 실패시킨다.
 */
process.env['NODE_ENV'] = 'test';
process.env['APP_ENV'] ??= 'dev';
process.env['APP_NAME'] ??= 'hanguksa5min';
process.env['LOG_LEVEL'] ??= 'silent';
// 테스트 전용 더미 값. 실제 secret 이 아니다.
process.env['SERVER_PEPPER'] ??= 'test-pepper-value-not-a-real-secret-0001';
process.env['SERVER_PEPPER_VERSION'] ??= '1';
process.env['INTERNAL_TOKEN_SECRET'] ??= 'test-token-signing-key-not-a-real-secret';
process.env['IDENTITY_PROVIDER'] ??= 'mock';

if (process.env['DATABASE_URL'] == null) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // CI 처럼 .env 파일이 없는 환경에서는 주입된 환경변수를 그대로 쓴다.
  }
}

if (process.env['DATABASE_URL'] == null || process.env['DATABASE_URL'].length === 0) {
  throw new Error(
    'DB 통합 테스트에는 실제 DATABASE_URL 이 필요합니다. `pnpm db:up && pnpm db:migrate` 후 다시 실행하세요.',
  );
}
