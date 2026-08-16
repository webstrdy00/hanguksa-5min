import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users } from '../db/schema/identity.ts';
import { AppError } from '../http/errors.ts';
import { logger } from '../observability/logger.ts';
import {
  buildFingerprintCandidates,
  revokedFingerprint,
  type FingerprintCandidate,
} from './fingerprint.ts';
import type { IdentityProvider } from './identity-provider.ts';
import { issueAccessToken, type AccessToken } from './token.ts';

/**
 * bootstrap 인증 로직 (공통 06 §1).
 *
 * 흐름:
 *   1. anonKey 로 fingerprint 후보를 만든다(현재 pepper + 이전 pepper).
 *   2. 후보로 기존 사용자를 찾는다. 찾으면 검증 API 를 호출하지 않는다.
 *      - 앱인토스 검증 API 는 앱당 분당 3,000회 한도가 있다. 재방문마다 호출하면 안 된다.
 *   3. 없으면 검증 API 를 호출하고, 유효할 때만 계정을 만든다.
 *   4. 내부 access token 을 발급한다.
 */

export interface BootstrapResult {
  userId: string;
  accessToken: AccessToken;
  /** 신규 가입 여부. 분석/운영 지표용이며 사용자 식별 정보는 아니다. */
  created: boolean;
  /** 이번 요청에서 실제로 앱인토스 검증 API 를 호출했는지. */
  verified: boolean;
}

interface UserRow {
  id: string;
  identityStatus: string;
  anonKeyFingerprintVersion: number;
}

export class AuthService {
  readonly #identityProvider: IdentityProvider;

  constructor(identityProvider: IdentityProvider) {
    this.#identityProvider = identityProvider;
  }

  async bootstrap(anonKey: string): Promise<BootstrapResult> {
    const candidates = buildFingerprintCandidates(anonKey);
    const current = candidates[0];
    if (current == null) {
      throw new AppError('INTERNAL_ERROR');
    }

    const existing = await this.#findUser(candidates);

    if (existing != null) {
      // 차단 계정은 재접속해도 통과시키지 않는다.
      if (existing.identityStatus === 'blocked') {
        throw new AppError('FORBIDDEN');
      }

      // 삭제된 계정은 재사용하지 않는다. 삭제 이행이 끝나지 않아 매핑이 남아 있으면
      // 그 자리에서 매핑을 폐기하고 새 계정을 만든다 (재가입 허용 정책).
      if (existing.identityStatus === 'deleted') {
        return await this.#recreateAfterDeletion(existing.id, current);
      }

      await this.#refreshMappingIfRotated(existing, current);

      return {
        userId: existing.id,
        accessToken: await issueAccessToken(existing.id),
        created: false,
        verified: false,
      };
    }

    // 처음 보는 식별키만 검증한다.
    const outcome = await this.#identityProvider.verifyAnonKey(anonKey);

    if (outcome.status === 'invalid') {
      logger.warn({ reason: outcome.reason }, 'identity_verification_rejected');
      throw new AppError('INVALID_USER_KEY');
    }

    if (outcome.status === 'unavailable') {
      // 검증할 수 없으면 계정을 만들지 않는다. 잘못된 사용자 데이터가 생기는 것보다 실패가 낫다.
      logger.warn({ reason: outcome.reason }, 'identity_verification_unavailable');
      throw new AppError('IDENTITY_PROVIDER_UNAVAILABLE');
    }

    return await this.#createUser(current, { verified: true });
  }

  async #findUser(candidates: FingerprintCandidate[]): Promise<UserRow | null> {
    const rows = await db
      .select({
        id: users.id,
        identityStatus: users.identityStatus,
        anonKeyFingerprintVersion: users.anonKeyFingerprintVersion,
        anonKeyFingerprint: users.anonKeyFingerprint,
      })
      .from(users)
      .where(
        inArray(
          users.anonKeyFingerprint,
          candidates.map((candidate) => candidate.fingerprint),
        ),
      );

    if (rows.length === 0) return null;

    // 현재 버전 매칭을 우선한다.
    for (const candidate of candidates) {
      const matched = rows.find((row) => row.anonKeyFingerprint === candidate.fingerprint);
      if (matched != null) {
        return {
          id: matched.id,
          identityStatus: matched.identityStatus,
          anonKeyFingerprintVersion: matched.anonKeyFingerprintVersion,
        };
      }
    }

    return null;
  }

  /**
   * pepper 회전 후 구 버전으로 찾은 사용자를 현재 버전으로 옮긴다.
   * 실패해도 로그인 자체를 막지 않는다. 다음 접속에서 다시 시도된다.
   */
  async #refreshMappingIfRotated(user: UserRow, current: FingerprintCandidate): Promise<void> {
    if (user.anonKeyFingerprintVersion === current.version) return;

    try {
      await db
        .update(users)
        .set({
          anonKeyFingerprint: current.fingerprint,
          anonKeyFingerprintVersion: current.version,
        })
        .where(and(eq(users.id, user.id), eq(users.identityStatus, 'active')));

      logger.info(
        { fromVersion: user.anonKeyFingerprintVersion, toVersion: current.version },
        'anon_key_fingerprint_rotated',
      );
    } catch (error) {
      logger.error({ err: error }, 'anon_key_fingerprint_rotation_failed');
    }
  }

  /**
   * 삭제된 계정의 fingerprint 매핑을 폐기하고 새 계정을 만든다.
   *
   * anon_key_fingerprint 는 UNIQUE 라서 삭제된 행이 값을 잡고 있으면
   * 같은 anonKey 로 다시 들어온 사용자가 새 계정을 만들 수 없다.
   * 두 작업은 반드시 같은 트랜잭션에서 이뤄져야 한다.
   */
  async #recreateAfterDeletion(
    deletedUserId: string,
    current: FingerprintCandidate,
  ): Promise<BootstrapResult> {
    const newUserId = await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ anonKeyFingerprint: revokedFingerprint(deletedUserId) })
        .where(eq(users.id, deletedUserId));

      const [created] = await tx
        .insert(users)
        .values({
          anonKeyFingerprint: current.fingerprint,
          anonKeyFingerprintVersion: current.version,
          identityVerifiedAt: new Date(),
        })
        .returning({ id: users.id });

      return created?.id ?? null;
    });

    if (newUserId == null) {
      throw new AppError('INTERNAL_ERROR');
    }

    logger.info({ event: 'reregistered_after_deletion' }, 'user_recreated');

    return {
      userId: newUserId,
      accessToken: await issueAccessToken(newUserId),
      created: true,
      verified: false,
    };
  }

  async #createUser(
    current: FingerprintCandidate,
    options: { verified: boolean },
  ): Promise<BootstrapResult> {
    // 동시에 같은 anonKey 로 bootstrap 이 들어와도 UNIQUE 제약 덕분에 계정은 하나만 생긴다.
    // 두 번째 요청은 아무 행도 반환받지 못하므로 다시 조회해서 같은 계정을 쓴다.
    const inserted = await db
      .insert(users)
      .values({
        anonKeyFingerprint: current.fingerprint,
        anonKeyFingerprintVersion: current.version,
        identityVerifiedAt: new Date(),
      })
      .onConflictDoNothing({ target: users.anonKeyFingerprint })
      .returning({ id: users.id });

    const createdId = inserted[0]?.id;

    if (createdId != null) {
      return {
        userId: createdId,
        accessToken: await issueAccessToken(createdId),
        created: true,
        verified: options.verified,
      };
    }

    const [raced] = await db
      .select({ id: users.id, identityStatus: users.identityStatus })
      .from(users)
      .where(eq(users.anonKeyFingerprint, current.fingerprint))
      .limit(1);

    if (raced == null) {
      throw new AppError('INTERNAL_ERROR');
    }
    if (raced.identityStatus === 'blocked') {
      throw new AppError('FORBIDDEN');
    }

    return {
      userId: raced.id,
      accessToken: await issueAccessToken(raced.id),
      created: false,
      verified: options.verified,
    };
  }
}
