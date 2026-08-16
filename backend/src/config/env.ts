import process from 'node:process';
import { z } from 'zod';

/**
 * 환경변수 계약.
 *
 * 근거:
 * - 공통 02 §2: dev / staging / production 을 논리적으로 구분한다.
 * - 공통 04 §2, 공통 06 §6: secret은 코드가 아니라 환경변수/Secret Manager에만 둔다.
 * - 하드게이트: 콘솔 appName과 apps-in-toss.config.ts appName 일치. APP_NAME이 CORS allowlist를 만든다.
 *
 * 값이 없거나 형식이 틀리면 서버를 띄우지 않는다(fail fast).
 * 오류 출력에 값 자체는 절대 찍지 않는다.
 */

/** appName은 `https://<appName>.web.tossmini.com` 서브도메인으로 쓰인다. */
const dnsLabel = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, '소문자/숫자/하이픈만 사용할 수 있어요.');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** 배포 환경 구분. 로그/CORS/보안 헤더 동작이 이 값에 따라 달라진다. */
  APP_ENV: z.enum(['dev', 'staging', 'production']).default('dev'),
  APP_NAME: dnsLabel,
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  /**
   * 로컬 개발용 추가 CORS origin (쉼표 구분).
   * production 에서는 무시한다. 운영 origin 은 APP_NAME 에서만 파생한다.
   */
  ADDITIONAL_CORS_ORIGINS: z.string().optional(),

  // -------------------------------------------------------------------------
  // 인증 (공통 06 §1~2)
  // 이 값들은 secret 이다. 코드/DB 에 두지 않고 .env 또는 Secret Manager 에만 둔다.
  // -------------------------------------------------------------------------

  /** anonKey fingerprint 생성용 HMAC pepper. */
  SERVER_PEPPER: z.string().min(32, '32자 이상이어야 해요.'),
  SERVER_PEPPER_VERSION: z.coerce.number().int().min(1).default(1),
  /**
   * 이전 pepper 목록. `버전:시크릿` 을 쉼표로 이어 붙인다.
   * 회전 직후 기존 사용자를 찾아 현재 버전으로 갱신하는 데만 쓴다.
   */
  SERVER_PEPPER_PREVIOUS: z.string().optional(),

  /** 내부 access token 서명 키 (JWT HS256). */
  INTERNAL_TOKEN_SECRET: z.string().min(32, '32자 이상이어야 해요.'),
  /** 공통 06 §1: 짧은 수명. 2026-08-15 기준 30분으로 확정. */
  INTERNAL_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(1800),

  /**
   * 사용자 식별키 검증 경로.
   * toss = 실제 앱인토스 API(mTLS 필수), mock = 개발용 대체 구현.
   */
  IDENTITY_PROVIDER: z.enum(['toss', 'mock']).default('mock'),
  AIT_USER_KEY_VERIFY_URL: z
    .string()
    .url()
    .default('https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/users/anon-key/verify'),
  AIT_MTLS_CERT_PATH: z.string().optional(),
  AIT_MTLS_KEY_PATH: z.string().optional(),
  /** 검증 API 타임아웃. 초과하면 재시도 없이 503 으로 안전 실패한다. */
  AIT_VERIFY_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(3000),

  // -------------------------------------------------------------------------
  // 관리자 (공통 04 §2: 사용자 API 와 인증 경계를 분리한다)
  // -------------------------------------------------------------------------

  /** 관리자 토큰 서명 키. 사용자 토큰 키와 반드시 다른 값이어야 한다. */
  ADMIN_TOKEN_SECRET: z.string().min(32, '32자 이상이어야 해요.'),
  /** 관리자 토큰은 CLI 로 발급한다. 사용자 토큰보다는 길지만 상한을 둔다. */
  ADMIN_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(43_200),
  /** 설정하면 해당 IP 에서만 관리자 API 를 허용한다 (쉼표 구분). */
  ADMIN_IP_ALLOWLIST: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * 개별 필드 검증만으로는 잡을 수 없는 조합 규칙.
 * 운영에서 mock 인증이 도는 사고를 기동 시점에 막는 것이 핵심이다.
 */
const envSchemaWithRules = envSchema.superRefine((value, ctx) => {
  if (value.APP_ENV === 'production' && value.IDENTITY_PROVIDER !== 'toss') {
    ctx.addIssue({
      code: 'custom',
      path: ['IDENTITY_PROVIDER'],
      message: '운영 환경에서는 mock 식별키 검증을 사용할 수 없어요.',
    });
  }

  if (value.IDENTITY_PROVIDER === 'toss') {
    if (value.AIT_MTLS_CERT_PATH == null || value.AIT_MTLS_KEY_PATH == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['AIT_MTLS_CERT_PATH'],
        message: '앱인토스 서버 API 는 mTLS 가 필수예요. 인증서와 키 경로가 필요해요.',
      });
    }
  }

  if (value.APP_ENV === 'production' && value.SERVER_PEPPER === value.INTERNAL_TOKEN_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['INTERNAL_TOKEN_SECRET'],
      message: 'pepper 와 토큰 서명 키는 서로 달라야 해요.',
    });
  }

  // 사용자 토큰으로 관리자 API 가 열리는 사고를 키 단계에서 막는다.
  if (value.ADMIN_TOKEN_SECRET === value.INTERNAL_TOKEN_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['ADMIN_TOKEN_SECRET'],
      message: '관리자 토큰 키는 사용자 토큰 키와 달라야 해요.',
    });
  }
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchemaWithRules.safeParse(source);

  if (!result.success) {
    // 값은 출력하지 않는다. 어떤 키가 왜 틀렸는지만 알린다.
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`환경변수 설정이 올바르지 않습니다.\n${problems}`);
  }

  return result.data;
}

export const env: Env = loadEnv();

export const isProduction = env.APP_ENV === 'production';
