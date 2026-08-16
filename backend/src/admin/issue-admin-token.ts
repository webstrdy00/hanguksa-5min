import process from 'node:process';
import { eq } from 'drizzle-orm';
import { issueAdminToken } from '../auth/admin-token.ts';
import { env } from '../config/env.ts';
import { closeDb, db } from '../db/client.ts';
import { adminUsers } from '../db/schema/admin.ts';

/**
 * 관리자 토큰 발급 CLI.
 *
 * 관리자 로그인 화면을 만들지 않는다(공통 04 §2, MVP 범위).
 * 운영자는 이 명령으로 토큰을 받아 콘솔 도구에서 사용한다.
 *
 *   pnpm --filter @hanguksa/backend admin:token -- reviewer@example.com
 *
 * 발급된 토큰은 Secret Manager 나 개인 비밀번호 관리자에 보관한다.
 * 터미널 히스토리에 남지 않도록 주의한다.
 */
async function main(): Promise<void> {
  const email = process.argv[2];

  if (email == null || email.length === 0) {
    throw new Error('사용법: admin:token <관리자 이메일>');
  }

  const [admin] = await db
    .select({ id: adminUsers.id, role: adminUsers.role, status: adminUsers.status })
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);

  if (admin == null) {
    throw new Error(`관리자 계정을 찾을 수 없습니다: ${email}`);
  }
  if (admin.status !== 'active') {
    throw new Error(`비활성화된 관리자 계정입니다: ${email}`);
  }

  const token = await issueAdminToken(admin.id, admin.role);

  console.log(`role:      ${admin.role}`);
  console.log(`expiresAt: ${token.expiresAt.toISOString()} (${env.ADMIN_TOKEN_TTL_SECONDS}초)`);
  console.log('token:');
  console.log(token.token);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
