import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import type { IdentityProvider, VerificationOutcome } from '../auth/identity-provider.ts';
import { createTestClient, truncateAll } from '../db/test-helpers.ts';
import type { AppInstance } from '../http/types.ts';

/**
 * 알림 동의 통합 테스트 (공통 01 §4, 공통 04 §1).
 *
 * 하드게이트: "동의 없이 발송 0건". 그 전제가 동의 기록이 정확한 것이다.
 */
class AlwaysValidProvider implements IdentityProvider {
  readonly name = 'stub';
  verifyAnonKey(): Promise<VerificationOutcome> {
    return Promise.resolve({ status: 'valid' });
  }
}

let sql: postgres.Sql;
let app: AppInstance;
let token: string;

function auth() {
  return { authorization: `Bearer ${token}` };
}

interface ConsentBody {
  consent: {
    functionalAgreed: boolean;
    functionalAgreedAt: string | null;
    marketingAgreed: boolean;
    pushTargetStatus: string;
  };
}

async function getConsent(): Promise<ConsentBody> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/notifications/consent',
    headers: auth(),
  });
  return response.json<ConsentBody>();
}

async function putConsent(result: string, channel?: string) {
  return await app.inject({
    method: 'PUT',
    url: '/v1/notifications/consent',
    headers: auth(),
    payload: channel == null ? { result } : { result, channel },
  });
}

beforeAll(() => {
  sql = createTestClient();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await truncateAll(sql);
  app = await buildApp({ identityProvider: new AlwaysValidProvider() });
  await app.ready();

  const boot = await app.inject({
    method: 'POST',
    url: '/v1/auth/bootstrap',
    payload: { anonKey: 'anon-notification-user' },
  });
  token = boot.json<{ accessToken: string }>().accessToken;
});

afterEach(async () => {
  await app.close();
});

describe('GET /v1/notifications/consent', () => {
  it('인증 없이 조회할 수 없다', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/notifications/consent' });
    expect(response.statusCode).toBe(401);
  });

  it('동의한 적 없으면 미동의 상태를 돌려주고 행을 만들지 않는다', async () => {
    const body = await getConsent();

    expect(body.consent.functionalAgreed).toBe(false);
    expect(body.consent.functionalAgreedAt).toBeNull();
    expect(body.consent.pushTargetStatus).toBe('unknown');

    // 동의 전에 발송 대상 행을 미리 만들지 않는다.
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from notification_consents
    `;
    expect(row?.count).toBe('0');
  });
});

describe('PUT /v1/notifications/consent', () => {
  it('동의하면 동의 시각과 발송 대상 상태를 함께 기록한다', async () => {
    const response = await putConsent('newAgreement');

    expect(response.statusCode).toBe(200);

    const body = response.json<ConsentBody>();
    expect(body.consent.functionalAgreed).toBe(true);
    expect(body.consent.functionalAgreedAt).not.toBeNull();
    expect(body.consent.pushTargetStatus).toBe('active');
  });

  it('이미 동의한 상태도 동의로 기록한다', async () => {
    await putConsent('newAgreement');
    const response = await putConsent('alreadyAgreed');

    expect(response.json<ConsentBody>().consent.functionalAgreed).toBe(true);
  });

  it('거절하면 동의를 해제하고 발송 대상에서 뺀다', async () => {
    await putConsent('newAgreement');
    const response = await putConsent('agreementRejected');

    const body = response.json<ConsentBody>();
    expect(body.consent.functionalAgreed).toBe(false);
    expect(body.consent.functionalAgreedAt).toBeNull();
    expect(body.consent.pushTargetStatus).toBe('revoked');
  });

  it('기능성과 광고성 동의를 따로 관리한다 (공통 01 §4)', async () => {
    await putConsent('newAgreement', 'functional');
    const body = await getConsent();

    expect(body.consent.functionalAgreed).toBe(true);
    // 기능성에 동의해도 광고성 동의로 번지지 않는다.
    expect(body.consent.marketingAgreed).toBe(false);
  });

  it('여러 번 호출해도 행이 하나만 유지된다', async () => {
    await putConsent('newAgreement');
    await putConsent('newAgreement');
    await putConsent('alreadyAgreed');

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from notification_consents
    `;
    expect(row?.count).toBe('1');
  });

  it('정의되지 않은 결과값은 400 이다', async () => {
    const response = await putConsent('maybe');
    expect(response.statusCode).toBe(400);
  });

  it('동의 상태와 시각이 어긋난 채로 저장되지 않는다 (DB CHECK)', async () => {
    await putConsent('newAgreement');

    const [row] = await sql<{ functional_agreed: boolean; functional_agreed_at: Date | null }[]>`
      select functional_agreed, functional_agreed_at from notification_consents
    `;

    expect(row?.functional_agreed).toBe(true);
    expect(row?.functional_agreed_at).not.toBeNull();
  });
});
