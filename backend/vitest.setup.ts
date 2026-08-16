import process from 'node:process';

/**
 * 테스트 실행에 필요한 최소 환경변수.
 * 실제 secret 은 들어가지 않는다. DB 연결이 필요한 테스트만 실제 DATABASE_URL 을 사용한다.
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
process.env['DATABASE_URL'] ??= 'postgres://test:test@127.0.0.1:5432/test';
