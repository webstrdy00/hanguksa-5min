import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';

/**
 * anonKey fingerprint (공통 06 §1 3단계).
 *
 * anonKey 원문은 저장하지 않는다. 조회 키는 HMAC-SHA256(pepper, anonKey) 이다.
 * pepper 는 서버만 알고 있으므로 DB 가 통째로 유출돼도 원본 식별키를 되돌릴 수 없다.
 *
 * pepper 회전 문제:
 *   원문을 보관하지 않으니 저장된 fingerprint 를 새 pepper 로 재계산할 수 없다.
 *   그런데 bootstrap 요청에는 원문이 들어온다. 그래서 구 버전으로 한 번 더 조회해
 *   사용자를 찾은 뒤 현재 버전 fingerprint 로 갱신하면 계정 유실 없이 회전할 수 있다.
 */

export interface PepperVersion {
  version: number;
  secret: string;
}

/**
 * `버전:시크릿,버전:시크릿` 형식을 파싱한다.
 * 형식이 깨지면 조용히 무시하지 않고 즉시 실패시킨다. 회전 설정 오타는 계정 유실로 이어진다.
 */
export function parsePreviousPeppers(raw: string | undefined): PepperVersion[] {
  if (raw == null || raw.trim().length === 0) return [];

  return raw.split(',').map((entry) => {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(
        'SERVER_PEPPER_PREVIOUS 형식이 올바르지 않습니다. `버전:시크릿` 이어야 합니다.',
      );
    }

    const version = Number(entry.slice(0, separatorIndex).trim());
    const secret = entry.slice(separatorIndex + 1).trim();

    if (!Number.isInteger(version) || version < 1) {
      throw new Error('SERVER_PEPPER_PREVIOUS 의 버전은 1 이상의 정수여야 합니다.');
    }
    if (secret.length === 0) {
      throw new Error('SERVER_PEPPER_PREVIOUS 의 시크릿이 비어 있습니다.');
    }

    return { version, secret };
  });
}

export function computeFingerprint(anonKey: string, secret: string): string {
  return createHmac('sha256', secret).update(anonKey, 'utf8').digest('hex');
}

export interface FingerprintCandidate {
  version: number;
  fingerprint: string;
}

/**
 * 조회에 사용할 fingerprint 후보를 만든다.
 * 첫 번째가 항상 현재 버전이고, 뒤이어 이전 버전들이 온다.
 */
export function buildFingerprintCandidates(anonKey: string): FingerprintCandidate[] {
  const current: FingerprintCandidate = {
    version: env.SERVER_PEPPER_VERSION,
    fingerprint: computeFingerprint(anonKey, env.SERVER_PEPPER),
  };

  const previous = parsePreviousPeppers(env.SERVER_PEPPER_PREVIOUS)
    .filter((pepper) => pepper.version !== env.SERVER_PEPPER_VERSION)
    .map((pepper) => ({
      version: pepper.version,
      fingerprint: computeFingerprint(anonKey, pepper.secret),
    }));

  return [current, ...previous];
}

/** 길이가 같을 때만 상수 시간 비교한다. 로그인 비교가 아니라 방어적 습관이다. */
export function fingerprintEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 삭제 시 매핑을 폐기하기 위한 값 (공통 04 §4).
 *
 * anon_key_fingerprint 는 UNIQUE 라서, 삭제된 행이 값을 계속 붙잡고 있으면
 * 같은 anonKey 로 다시 들어온 사용자가 새 계정을 만들 수 없다.
 * 삭제 시점에 이 값으로 치환해 매핑을 끊는다.
 */
export function revokedFingerprint(userId: string): string {
  return `revoked:${userId}`;
}
