export type AuthInitializationErrorCode =
  | 'AUTH_IDENTITY_FAILED'
  | 'AUTH_IDENTITY_TIMEOUT'
  | 'AUTH_RESPONSE_INVALID'
  | 'AUTH_BOOTSTRAP_FAILED';

const messages: Record<AuthInitializationErrorCode, string> = {
  AUTH_IDENTITY_FAILED: '토스 사용자 식별 정보를 확인할 수 없어요.',
  AUTH_IDENTITY_TIMEOUT: '토스 사용자 식별 정보 확인이 늦어지고 있어요.',
  AUTH_RESPONSE_INVALID: '인증 서버의 응답을 확인할 수 없어요.',
  AUTH_BOOTSTRAP_FAILED: '인증을 완료할 수 없어요.',
};

/** 원본 오류나 인증 정보를 담지 않는 고정된 인증 단계별 안내. */
export class AuthInitializationError extends Error {
  readonly code: AuthInitializationErrorCode;

  constructor(code: AuthInitializationErrorCode) {
    super(`${messages[code]} 잠시 후 다시 시도해주세요. (${code})`);
    this.name = 'AuthInitializationError';
    this.code = code;
  }
}
