import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAdminToken } from '../auth/admin-token.ts';
import { extractBearerToken } from '../auth/token.ts';
import { env } from '../config/env.ts';
import { db } from '../db/client.ts';
import { adminUsers } from '../db/schema/admin.ts';
import { AppError } from './errors.ts';

/**
 * 관리자 인증 (공통 04 §2).
 *
 * 사용자 인증과 같은 파일에 두지 않는다. 경계를 코드 구조에서도 분리한다.
 * - 관리자 토큰 전용 서명 키/issuer/audience 로만 통과한다.
 * - 매 요청 admin_users.status 를 확인한다. 비활성화가 즉시 반영돼야 한다.
 * - ADMIN_IP_ALLOWLIST 가 설정돼 있으면 그 IP 에서만 허용한다.
 */

export interface AuthenticatedAdmin {
  id: string;
  role: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedAdmin?: AuthenticatedAdmin;
  }
}

function parseAllowlist(raw: string | undefined): string[] {
  if (raw == null) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function authenticateAdmin(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const allowlist = parseAllowlist(env.ADMIN_IP_ALLOWLIST);
  if (allowlist.length > 0 && !allowlist.includes(request.ip)) {
    // 어떤 IP 가 허용되는지 알려주지 않는다.
    request.log.warn({ ip: request.ip }, 'admin_ip_rejected');
    throw new AppError('FORBIDDEN');
  }

  const token = extractBearerToken(request.headers.authorization);
  if (token == null) {
    throw new AppError('AUTH_REQUIRED');
  }

  let adminUserId: string;
  try {
    const verified = await verifyAdminToken(token);
    adminUserId = verified.adminUserId;
  } catch {
    // 사용자 토큰을 넣은 경우도 여기로 온다. 이유를 구분해 알려주지 않는다.
    throw new AppError('AUTH_REQUIRED');
  }

  const [admin] = await db
    .select({
      id: adminUsers.id,
      role: adminUsers.role,
      status: adminUsers.status,
      email: adminUsers.email,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId))
    .limit(1);

  if (admin == null || admin.status !== 'active') {
    throw new AppError('FORBIDDEN');
  }

  request.authenticatedAdmin = { id: admin.id, role: admin.role, email: admin.email };
}

export function requireAdmin(request: FastifyRequest): AuthenticatedAdmin {
  const admin = request.authenticatedAdmin;
  if (admin == null) {
    throw new AppError('AUTH_REQUIRED');
  }
  return admin;
}

/** 역할 기반 제한. 콘텐츠 발행/일정 변경은 editor 이상이어야 한다. */
export function requireRole(
  request: FastifyRequest,
  allowed: readonly string[],
): AuthenticatedAdmin {
  const admin = requireAdmin(request);
  if (!allowed.includes(admin.role)) {
    throw new AppError('FORBIDDEN');
  }
  return admin;
}
