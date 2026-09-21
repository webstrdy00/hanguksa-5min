import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { extractBearerToken, verifyAccessToken } from '../auth/token.ts';
import { db } from '../db/client.ts';
import { users } from '../db/schema/identity.ts';
import { isDeletionRequested } from '../deletion-journal/runtime.ts';
import { AppError } from './errors.ts';

/**
 * 내부 access token 인증 (공통 06 §4).
 *
 * - Authorization: Bearer <internal-access-token> 만 받는다. anonKey 를 다시 받지 않는다.
 * - 토큰 검증만으로 끝내지 않고 DB 에서 계정 상태를 확인한다.
 *   무상태 토큰이라 발급 후 폐기가 불가능하므로, 삭제/차단을 즉시 반영하려면
 *   요청마다 상태를 봐야 한다 (공통 04 §5: 삭제 성공 후 토큰 즉시 무효화).
 * - 권한 판정은 URL 의 user_id 가 아니라 여기서 만든 컨텍스트로만 한다 (공통 04 §2).
 */

export interface AuthenticatedUser {
  id: string;
  identityStatus: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser?: AuthenticatedUser;
  }
}

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(request.headers.authorization);

  if (token == null) {
    throw new AppError('AUTH_REQUIRED');
  }

  let userId: string;
  try {
    const verified = await verifyAccessToken(token);
    userId = verified.userId;
  } catch {
    // 만료/위조/형식 오류를 구분해서 알려주지 않는다. 공격자에게 정보를 주지 않는다.
    throw new AppError('AUTH_REQUIRED');
  }

  const [user] = await db
    .select({ id: users.id, identityStatus: users.identityStatus })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (user == null) {
    // 토큰은 유효하지만 계정이 이미 파기됐다.
    throw new AppError('USER_DELETED');
  }
  if (user.identityStatus === 'deleted') {
    throw new AppError('USER_DELETED');
  }
  if (user.identityStatus !== 'active') {
    throw new AppError('FORBIDDEN');
  }
  if (await isDeletionRequested(user.id)) {
    throw new AppError('USER_DELETED');
  }

  request.authenticatedUser = user;
}

/** 인증된 사용자를 꺼낸다. authenticate 를 preHandler 로 건 라우트에서만 쓴다. */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.authenticatedUser;
  if (user == null) {
    throw new AppError('AUTH_REQUIRED');
  }
  return user;
}
