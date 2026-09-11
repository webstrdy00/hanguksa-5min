import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyTypeProviderDefault, RawServerDefault } from 'fastify';
import type { Logger } from 'pino';

/**
 * 공유 pino 인스턴스를 주입한 Fastify 인스턴스 타입.
 *
 * 기본 FastifyInstance 는 로거 타입이 FastifyBaseLogger 라서,
 * loggerInstance 로 pino Logger 를 넘긴 인스턴스와는 타입이 맞지 않는다.
 * 플러그인 등록 함수들이 같은 인스턴스 타입을 쓰도록 여기서 한 번만 정의한다.
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger,
  FastifyTypeProviderDefault
>;
