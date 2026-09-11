import { readFileSync } from 'node:fs';
import { Agent, request } from 'undici';
import { env } from '../config/env.ts';
import { logger } from '../observability/logger.ts';
import {
  interpretVerifyResponse,
  type IdentityProvider,
  type VerificationOutcome,
} from './identity-provider.ts';

/**
 * 실제 앱인토스 식별 키 검증 구현체.
 *
 * - mTLS 필수 (공통 06 §6). 인증서/키는 Secret Manager 에 두고 경로만 환경변수로 받는다.
 * - 재시도하지 않는다. 실패하면 즉시 503 으로 안전 실패시킨다 (공통 04 §9).
 *   사용자 요청을 붙잡지 않고, 앱당 3,000 QPM 한도도 아낀다. 재시도는 클라이언트가 백오프로 한다.
 * - 호출 실패를 애플리케이션 오류와 구분해 관측한다 (공통 06 §6).
 *
 * 방화벽 Outbound 허용 필요: 117.52.3.192 / 211.115.96.192 / 106.249.5.192 (443)
 */
export class TossIdentityProvider implements IdentityProvider {
  readonly name = 'toss';
  readonly #agent: Agent;

  constructor() {
    if (env.AIT_MTLS_CERT_PATH == null || env.AIT_MTLS_KEY_PATH == null) {
      throw new Error(
        'mTLS 인증서 경로가 없습니다. AIT_MTLS_CERT_PATH / AIT_MTLS_KEY_PATH 를 설정하세요.',
      );
    }

    // 파일을 읽지 못하면 기동 시점에 실패시킨다. 첫 사용자 요청에서 터지게 두지 않는다.
    const cert = readFileSync(env.AIT_MTLS_CERT_PATH);
    const key = readFileSync(env.AIT_MTLS_KEY_PATH);

    this.#agent = new Agent({
      connect: { cert, key },
      headersTimeout: env.AIT_VERIFY_TIMEOUT_MS,
      bodyTimeout: env.AIT_VERIFY_TIMEOUT_MS,
      connections: 16,
    });
  }

  async verifyAnonKey(anonKey: string): Promise<VerificationOutcome> {
    const startedAt = Date.now();

    try {
      const response = await request(env.AIT_USER_KEY_VERIFY_URL, {
        method: 'POST',
        // 본문 없이 헤더로만 전달한다. anonKey 를 URL 에 넣지 않는다.
        headers: { 'x-anon-key': anonKey, accept: 'application/json' },
        dispatcher: this.#agent,
        signal: AbortSignal.timeout(env.AIT_VERIFY_TIMEOUT_MS),
      });

      const body: unknown = await response.body.json().catch(() => null);
      const outcome = interpretVerifyResponse(response.statusCode, body);

      this.#logOutcome(outcome, response.statusCode, Date.now() - startedAt);
      return outcome;
    } catch (error) {
      // 타임아웃/커넥션/인증서 오류. 원인은 로그로만 남기고 사용자에게는 일시 장애로 알린다.
      logger.error(
        { err: error, provider: this.name, durationMs: Date.now() - startedAt },
        'identity_verify_transport_failed',
      );
      return { status: 'unavailable', reason: 'transport_error' };
    }
  }

  #logOutcome(outcome: VerificationOutcome, httpStatus: number, durationMs: number): void {
    // anonKey 원문은 어떤 경우에도 남기지 않는다.
    const base = { provider: this.name, httpStatus, durationMs, outcome: outcome.status };

    if (outcome.status === 'unavailable') {
      if (outcome.reason === 'bad_request') {
        logger.error({ ...base, reason: outcome.reason }, 'identity_verify_request_rejected');
        return;
      }
      logger.warn(
        { ...base, reason: outcome.reason, retryAfterSeconds: outcome.retryAfterSeconds },
        'identity_verify_unavailable',
      );
      return;
    }

    logger.info(base, 'identity_verify_completed');
  }
}
