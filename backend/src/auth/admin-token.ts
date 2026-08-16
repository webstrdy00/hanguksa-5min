import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.ts';
import { InvalidTokenError } from './token.ts';

/**
 * 관리자 토큰 (공통 04 §2: 관리자 API 는 사용자 API 와 별도 인증/권한을 사용한다).
 *
 * 사용자 토큰과 완전히 분리한다.
 * - 서명 키가 다르다 (ADMIN_TOKEN_SECRET). env 검증이 같은 값을 쓰지 못하게 막는다.
 * - issuer / audience / typ 가 다르다. 사용자 토큰을 관리자 API 에 넣어도 통과할 수 없다.
 * - 발급은 런타임 API 가 아니라 CLI 로만 한다. 로그인 화면을 만들지 않는다.
 */

const ALGORITHM = 'HS256';
const ISSUER = 'hanguksa5min-admin';
const AUDIENCE = 'hanguksa5min-console';
const TOKEN_TYPE = 'admin_access';

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.ADMIN_TOKEN_SECRET);
}

export interface AdminToken {
  token: string;
  expiresAt: Date;
}

export async function issueAdminToken(
  adminUserId: string,
  role: string,
  now = new Date(),
): Promise<AdminToken> {
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + env.ADMIN_TOKEN_TTL_SECONDS;

  const token = await new SignJWT({ typ: TOKEN_TYPE, role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(adminUserId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .setJti(randomUUID())
    .sign(secretKey());

  return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
}

export interface VerifiedAdminToken {
  adminUserId: string;
  role: string;
}

export async function verifyAdminToken(token: string): Promise<VerifiedAdminToken> {
  let payload: JWTPayload;

  try {
    const result = await jwtVerify(token, secretKey(), {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
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
  if (typeof payload['role'] !== 'string') {
    throw new InvalidTokenError('missing_role');
  }

  return { adminUserId: payload.sub, role: payload['role'] };
}
