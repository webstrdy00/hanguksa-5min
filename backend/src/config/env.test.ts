import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.ts';

/** 실제 자격증명이 아니라 형식만 맞춘 테스트용 문자열이다. */
const FAKE_DB_PASSWORD = ['not', 'a', 'real', 'password'].join('-');
const fakeDatabaseUrl = `postgres://user:${FAKE_DB_PASSWORD}@127.0.0.1:5432/db`;

/** 테스트용 더미 secret. 실제 값이 아니다. */
const FAKE_PEPPER = 'fake-pepper-value-for-tests-0123456789';
const FAKE_TOKEN_SECRET = 'fake-token-secret-for-tests-0123456789';

const baseEnv = {
  APP_NAME: 'hanguksa5min',
  DATABASE_URL: fakeDatabaseUrl,
  SERVER_PEPPER: FAKE_PEPPER,
  INTERNAL_TOKEN_SECRET: FAKE_TOKEN_SECRET,
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
    const { DATABASE_URL: _omitted, ...withoutDatabase } = baseEnv;
    expect(() => loadEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('APP_NAME 이 없으면 실패한다', () => {
    const { APP_NAME: _omitted, ...withoutAppName } = baseEnv;
    expect(() => loadEnv(withoutAppName)).toThrow(/APP_NAME/);
  });

  it('인증 secret 이 없으면 서버를 띄우지 않는다', () => {
    const { SERVER_PEPPER: _pepper, ...withoutPepper } = baseEnv;
    expect(() => loadEnv(withoutPepper)).toThrow(/SERVER_PEPPER/);

    const { INTERNAL_TOKEN_SECRET: _token, ...withoutToken } = baseEnv;
    expect(() => loadEnv(withoutToken)).toThrow(/INTERNAL_TOKEN_SECRET/);
  });

  it('찮기 쉬운 secret 을 거부한다', () => {
    expect(() => loadEnv({ ...baseEnv, SERVER_PEPPER: 'short' })).toThrow(/SERVER_PEPPER/);
  });

  it('운영 환경에서 mock 식별키 검증을 거부한다', () => {
    expect(() => loadEnv({ ...baseEnv, APP_ENV: 'production', IDENTITY_PROVIDER: 'mock' })).toThrow(
      /IDENTITY_PROVIDER/,
    );
  });

  it('toss 검증을 쓰려면 mTLS 인증서 경로가 필요하다', () => {
    expect(() => loadEnv({ ...baseEnv, IDENTITY_PROVIDER: 'toss' })).toThrow(/AIT_MTLS_CERT_PATH/);

    const withCerts = loadEnv({
      ...baseEnv,
      IDENTITY_PROVIDER: 'toss',
      AIT_MTLS_CERT_PATH: '/secrets/client.crt',
      AIT_MTLS_KEY_PATH: '/secrets/client.key',
    });
    expect(withCerts.IDENTITY_PROVIDER).toBe('toss');
  });

  it('운영에서 pepper 와 토큰 서명 키가 같으면 거부한다', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        APP_ENV: 'production',
        IDENTITY_PROVIDER: 'toss',
        AIT_MTLS_CERT_PATH: '/secrets/client.crt',
        AIT_MTLS_KEY_PATH: '/secrets/client.key',
        INTERNAL_TOKEN_SECRET: FAKE_PEPPER,
      }),
    ).toThrow(/INTERNAL_TOKEN_SECRET/);
  });

  it('내부 토큰 TTL 기본값은 30분이다', () => {
    expect(loadEnv(baseEnv).INTERNAL_TOKEN_TTL_SECONDS).toBe(1800);
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
