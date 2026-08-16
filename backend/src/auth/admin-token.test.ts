import { describe, expect, it } from 'vitest';
import { env } from '../config/env.ts';
import { issueAdminToken, verifyAdminToken } from './admin-token.ts';
import { InvalidTokenError, issueAccessToken, verifyAccessToken } from './token.ts';

const ADMIN_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('관리자 토큰', () => {
  it('발급한 토큰을 검증하면 관리자 id 와 역할이 나온다', async () => {
    const issued = await issueAdminToken(ADMIN_ID, 'editor');
    const verified = await verifyAdminToken(issued.token);

    expect(verified.adminUserId).toBe(ADMIN_ID);
    expect(verified.role).toBe('editor');
  });

  it('사용자 토큰 키와 다른 키로 서명한다', () => {
    expect(env.ADMIN_TOKEN_SECRET).not.toBe(env.INTERNAL_TOKEN_SECRET);
  });

  it('만료된 관리자 토큰을 거부한다', async () => {
    const expired = await issueAdminToken(ADMIN_ID, 'admin', new Date(Date.now() - 86_400_000 * 2));
    await expect(verifyAdminToken(expired.token)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('사용자 토큰과 관리자 토큰의 경계 (공통 04 §2)', () => {
  it('사용자 토큰으로 관리자 검증을 통과할 수 없다', async () => {
    const userToken = await issueAccessToken(USER_ID);
    await expect(verifyAdminToken(userToken.token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('관리자 토큰으로 사용자 검증을 통과할 수 없다', async () => {
    const adminToken = await issueAdminToken(ADMIN_ID, 'admin');
    await expect(verifyAccessToken(adminToken.token)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
