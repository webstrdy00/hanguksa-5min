import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { env } from '../config/env.ts';
import {
  InvalidTokenError,
  extractBearerToken,
  issueAccessToken,
  verifyAccessToken,
} from './token.ts';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.INTERNAL_TOKEN_SECRET);
}

describe('issueAccessToken', () => {
  it('발급한 토큰을 다시 검증할 수 있다', async () => {
    const issued = await issueAccessToken(USER_ID);
    const verified = await verifyAccessToken(issued.token);

    expect(verified.userId).toBe(USER_ID);
    expect(issued.expiresInSeconds).toBe(env.INTERNAL_TOKEN_TTL_SECONDS);
  });

  it('TTL 은 환경변수 설정값을 따른다 (기본 30분)', async () => {
    const now = new Date('2026-08-15T00:00:00Z');
    const issued = await issueAccessToken(USER_ID, now);

    expect(issued.expiresAt.getTime() - now.getTime()).toBe(env.INTERNAL_TOKEN_TTL_SECONDS * 1000);
    expect(env.INTERNAL_TOKEN_TTL_SECONDS).toBe(1800);
  });

  it('매번 다른 jti 를 넣는다', async () => {
    const first = await issueAccessToken(USER_ID);
    const second = await issueAccessToken(USER_ID);
    expect(first.token).not.toBe(second.token);
  });
});

describe('verifyAccessToken', () => {
  it('만료된 토큰을 거부한다', async () => {
    const expired = await issueAccessToken(USER_ID, new Date(Date.now() - 3_600_000));
    await expect(verifyAccessToken(expired.token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('서명이 위조된 토큰을 거부한다', async () => {
    const issued = await issueAccessToken(USER_ID);
    const parts = issued.token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;

    await expect(verifyAccessToken(tampered)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('payload 를 바꾼 토큰을 거부한다', async () => {
    const issued = await issueAccessToken(USER_ID);
    const parts = issued.token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'someone-else', typ: 'access', exp: 9_999_999_999 }),
    ).toString('base64url');

    await expect(
      verifyAccessToken(`${parts[0]}.${forgedPayload}.${parts[2]}`),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('다른 키로 서명한 토큰을 거부한다', async () => {
    const foreign = await new SignJWT({ typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuer('hanguksa5min-backend')
      .setAudience('hanguksa5min-client')
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(new TextEncoder().encode('attacker-key-attacker-key-attacker-key'));

    await expect(verifyAccessToken(foreign)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('issuer / audience 가 다르면 거부한다', async () => {
    const wrongIssuer = await new SignJWT({ typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuer('someone-else')
      .setAudience('hanguksa5min-client')
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(secretKey());

    await expect(verifyAccessToken(wrongIssuer)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('access 가 아닌 토큰 유형을 거부한다', async () => {
    const wrongType = await new SignJWT({ typ: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuer('hanguksa5min-backend')
      .setAudience('hanguksa5min-client')
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(secretKey());

    await expect(verifyAccessToken(wrongType)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('쓰레기 문자열을 거부한다', async () => {
    await expect(verifyAccessToken('not-a-token')).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifyAccessToken('')).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('extractBearerToken', () => {
  it('Bearer 스킴만 받는다', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc')).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('abc')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});
