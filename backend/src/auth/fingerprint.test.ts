import { describe, expect, it } from 'vitest';
import {
  buildFingerprintCandidates,
  computeFingerprint,
  fingerprintEquals,
  parsePreviousPeppers,
  revokedFingerprint,
} from './fingerprint.ts';

describe('computeFingerprint', () => {
  it('같은 입력에는 같은 값을, 다른 pepper 에는 다른 값을 만든다', () => {
    const a = computeFingerprint('anon-key-1', 'pepper-a');
    const b = computeFingerprint('anon-key-1', 'pepper-a');
    const c = computeFingerprint('anon-key-1', 'pepper-b');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('결과에서 원본 식별키를 유추할 수 없다 (원문을 포함하지 않는다)', () => {
    const fingerprint = computeFingerprint('super-secret-anon-key', 'pepper');
    expect(fingerprint).not.toContain('super-secret-anon-key');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parsePreviousPeppers', () => {
  it('빈 값은 빈 목록이다', () => {
    expect(parsePreviousPeppers(undefined)).toEqual([]);
    expect(parsePreviousPeppers('')).toEqual([]);
    expect(parsePreviousPeppers('   ')).toEqual([]);
  });

  it('버전:시크릿 목록을 읽는다', () => {
    expect(parsePreviousPeppers('1:old-pepper,2:newer-pepper')).toEqual([
      { version: 1, secret: 'old-pepper' },
      { version: 2, secret: 'newer-pepper' },
    ]);
  });

  it('시크릿에 콜론이 있어도 첫 콜론만 구분자로 쓴다', () => {
    expect(parsePreviousPeppers('3:a:b:c')).toEqual([{ version: 3, secret: 'a:b:c' }]);
  });

  it('형식이 깨지면 조용히 무시하지 않고 실패한다', () => {
    // 설정 오타를 무시하면 기존 사용자를 못 찾아 계정이 통째로 유실된다.
    expect(() => parsePreviousPeppers('old-pepper')).toThrow();
    expect(() => parsePreviousPeppers(':secret')).toThrow();
    expect(() => parsePreviousPeppers('abc:secret')).toThrow();
    expect(() => parsePreviousPeppers('1:')).toThrow();
  });
});

describe('buildFingerprintCandidates', () => {
  it('현재 pepper 버전이 항상 첫 번째다', () => {
    const candidates = buildFingerprintCandidates('anon-key-1');

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]?.version).toBe(1);
    expect(candidates[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('fingerprintEquals', () => {
  it('같은 값만 참이다', () => {
    expect(fingerprintEquals('abc', 'abc')).toBe(true);
    expect(fingerprintEquals('abc', 'abd')).toBe(false);
    expect(fingerprintEquals('abc', 'abcd')).toBe(false);
    expect(fingerprintEquals('', '')).toBe(true);
  });
});

describe('revokedFingerprint', () => {
  it('사용자마다 다른 폐기값을 만들어 UNIQUE 충돌을 피한다', () => {
    const a = revokedFingerprint('11111111-1111-1111-1111-111111111111');
    const b = revokedFingerprint('22222222-2222-2222-2222-222222222222');

    expect(a).not.toBe(b);
    expect(a.startsWith('revoked:')).toBe(true);
  });
});
