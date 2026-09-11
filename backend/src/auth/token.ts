import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.ts';

/**
 * 내부 access token (공통 06 §1 5단계, §4).
 *
 * - HS256 JWT. 알고리즘을 검증 시점에 고정해 alg 혼동 공격을 막는다.
 * - TTL 30분. refresh token 은 두지 않는다. 만료되면 클라이언트가 bootstrap 을 다시 한다.
 * - 프론트는 메모리에만 보관한다(공통 02 §2: 웹 스토리지에 핵심 데이터 금지).
 *
 * 무상태 토큰이므로 발급 후 즉시 폐기가 불가능하다. 그래서 요청마다 DB 에서
 * identity_status 를 확인한다(공통 04 §5: 삭제 후 토큰 즉시 무효화).
 */

const ALGORITHM = 'HS256';
const ISSUER = 'hanguksa5min-backend';
const AUDIENCE = 'hanguksa5min-client';
const TOKEN_TYPE = 'access';

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.INTERNAL_TOKEN_SECRET);
}

export interface AccessToken {
  token: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

export async function issueAccessToken(userId: string, now = new Date()): Promise<AccessToken> {
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + env.INTERNAL_TOKEN_TTL_SECONDS;

  const token = await new SignJWT({ typ: TOKEN_TYPE })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .setJti(randomUUID())
    .sign(secretKey());

  return {
    token,
    expiresAt: new Date(expiresAtSeconds * 1000),
    expiresInSeconds: env.INTERNAL_TOKEN_TTL_SECONDS,
  };
}

export interface VerifiedToken {
  userId: string;
  jti: string | undefined;
  expiresAt: Date;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTokenError';
  }
}

export async function verifyAccessToken(token: string): Promise<VerifiedToken> {
  let payload: JWTPayload;

  try {
    const result = await jwtVerify(token, secretKey(), {
      // 허용 알고리즘을 명시하지 않으면 alg 혼동 공격에 노출된다.
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      // 서버 시계 오차를 이유로 만료를 느슨하게 봐주지 않는다.
      clockTolerance: 0,
    });
    payload = result.payload;
  } catch (error) {
    throw new InvalidTokenError(error instanceof Error ? error.name : 'verification_failed');
  }

  if (payload.sub == null || payload.sub.length === 0) {
    throw new InvalidTokenError('missing_subject');
  }
  if (payload['typ'] !== TOKEN_TYPE) {
    throw new InvalidTokenError('unexpected_token_type');
  }
  if (payload.exp == null) {
    throw new InvalidTokenError('missing_expiration');
  }

  return {
    userId: payload.sub,
    jti: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/** Authorization 헤더에서 Bearer 토큰만 뽑는다. */
export function extractBearerToken(headerValue: string | undefined): string | null {
  if (headerValue == null) return null;
  const match = /^Bearer (.+)$/.exec(headerValue.trim());
  return match?.[1]?.trim() ?? null;
}
