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
   * production에서는 무시한다. 운영 origin은 APP_NAME에서만 파생한다.
   */
  ADDITIONAL_CORS_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

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
