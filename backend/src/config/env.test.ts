import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.ts';

/** 실제 자격증명이 아니라 형식만 맞춘 테스트용 문자열이다. */
const FAKE_DB_PASSWORD = ['not', 'a', 'real', 'password'].join('-');
const fakeDatabaseUrl = `postgres://user:${FAKE_DB_PASSWORD}@127.0.0.1:5432/db`;

const baseEnv = {
  APP_NAME: 'hanguksa5min',
  DATABASE_URL: fakeDatabaseUrl,
};

describe('loadEnv', () => {
  it('필수 값이 있으면 기본값과 함께 통과한다', () => {
    const env = loadEnv({ ...baseEnv });

    expect(env.APP_ENV).toBe('dev');
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.HOST).toBe('0.0.0.0');
  });

  it('DATABASE_URL 이 없으면 서버를 띄우지 않는다', () => {
    expect(() => loadEnv({ APP_NAME: 'hanguksa5min' })).toThrow(/DATABASE_URL/);
  });

  it('APP_NAME 이 없으면 실패한다', () => {
    expect(() => loadEnv({ DATABASE_URL: baseEnv.DATABASE_URL })).toThrow(/APP_NAME/);
  });

  it('서브도메인으로 쓸 수 없는 APP_NAME 을 거부한다', () => {
    expect(() => loadEnv({ ...baseEnv, APP_NAME: 'Hanguksa_5min' })).toThrow(/APP_NAME/);
    expect(() => loadEnv({ ...baseEnv, APP_NAME: '-bad' })).toThrow(/APP_NAME/);
    expect(() => loadEnv({ ...baseEnv, APP_NAME: 'bad-' })).toThrow(/APP_NAME/);
  });

  it('APP_ENV 는 dev/staging/production 만 허용한다', () => {
    expect(loadEnv({ ...baseEnv, APP_ENV: 'staging' }).APP_ENV).toBe('staging');
    expect(() => loadEnv({ ...baseEnv, APP_ENV: 'qa' })).toThrow(/APP_ENV/);
  });

  it('PORT 범위를 검증한다', () => {
    expect(loadEnv({ ...baseEnv, PORT: '3000' }).PORT).toBe(3000);
    expect(() => loadEnv({ ...baseEnv, PORT: '0' })).toThrow(/PORT/);
    expect(() => loadEnv({ ...baseEnv, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadEnv({ ...baseEnv, PORT: 'http' })).toThrow(/PORT/);
  });

  it('오류 메시지에 환경변수 값을 노출하지 않는다', () => {
    expect(() => loadEnv({ APP_NAME: 'BAD_NAME', DATABASE_URL: fakeDatabaseUrl })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(FAKE_DB_PASSWORD) as unknown as string,
      }),
    );
  });
});
