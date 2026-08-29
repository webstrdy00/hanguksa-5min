import { pino, type Logger, type LoggerOptions } from 'pino';
import { env, isProduction } from '../config/env.ts';

/**
 * 로깅 계약.
 *
 * 근거:
 * - 공통 04 §4: anonKey 원문, 토큰, 사용자 답변 원문을 로그에 남기지 않는다.
 * - 공통 05 §2: 모든 요청은 내부 requestId로 추적한다.
 * - 09 §6: 일반 로그 보관 30일 이하, 답변 원문/anonKey 금지.
 *
 * redact 목록은 "실수로 통째로 객체를 로깅했을 때"를 막는 마지막 방어선이다.
 * 애초에 이런 값을 로그에 넣지 않는 것이 1차 방어다.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-anon-key"]',
  'headers.authorization',
  'headers["x-anon-key"]',
  'anonKey',
  '*.anonKey',
  'anonKeyValue',
  '*.anonKeyValue',
  'accessToken',
  '*.accessToken',
  'token',
  '*.token',
  'answerText',
  '*.answerText',
  'prompt',
  '*.prompt',
  'choices',
  '*.choices',
  'explanation',
  '*.explanation',
  'detail',
  '*.detail',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'privateKey',
  '*.privateKey',
];

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: REDACTED_PATHS,
    censor: '[REDACTED]',
  },
  base: {
    app: env.APP_NAME,
    appEnv: env.APP_ENV,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const logger: Logger = pino(
  isProduction || env.NODE_ENV === 'test'
    ? baseOptions
    : {
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      },
);

export type { Logger };
