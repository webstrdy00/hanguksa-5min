import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.ts';
import { idempotencyKeys } from '../db/schema/ops.ts';
import { AppError } from './errors.ts';

/**
 * Idempotency-Key 처리 (공통 05 §2, 공통 04 §2).
 *
 * 버튼 연타나 네트워크 재시도에도 논리 작업이 한 번만 생기게 한다.
 *
 * 동작:
 *   1. 같은 (actor, endpoint, key) 가 처음이면 in_progress 로 선점하고 핸들러를 실행한다.
 *   2. 이미 completed 이고 요청 본문이 같으면 저장된 응답을 그대로 재생한다.
 *   3. 같은 key 인데 본문이 다르면 422 로 거부한다. 다른 작업을 같은 키로 덮어쓰지 않는다.
 *   4. 아직 in_progress 면 409 로 돌려보낸다. 동시에 두 번 실행하지 않는다.
 *
 * 보관 기간은 24시간이다(하드게이트 §2). 만료분은 정리 배치가 지운다.
 */

const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyActor {
  actorKey: string;
  userId?: string;
  adminUserId?: string;
}

interface StoredResponse {
  status: number;
  body: unknown;
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyRecordId?: string | undefined;
  }
}

function hashRequest(request: FastifyRequest): string {
  const payload = JSON.stringify({
    method: request.method,
    url: request.url,
    body: request.body ?? null,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 핸들러 앞단에서 호출한다.
 * 저장된 응답이 있으면 그것을 돌려주고, 없으면 null 을 돌려준다(핸들러가 진행).
 */
export async function beginIdempotentRequest(
  request: FastifyRequest,
  actor: IdempotencyActor,
  endpoint: string,
): Promise<StoredResponse | null> {
  const key = request.headers['idempotency-key'];

  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new AppError('INVALID_REQUEST', {
      details: {
        header: 'Idempotency-Key',
        message: '이 요청에는 Idempotency-Key 헤더가 필요해요.',
      },
    });
  }
  if (key.length > 128) {
    throw new AppError('INVALID_REQUEST', {
      details: { header: 'Idempotency-Key', message: '키가 너무 길어요.' },
    });
  }

  const requestHash = hashRequest(request);

  const inserted = await db
    .insert(idempotencyKeys)
    .values({
      actorKey: actor.actorKey,
      ...(actor.userId == null ? {} : { userId: actor.userId }),
      ...(actor.adminUserId == null ? {} : { adminUserId: actor.adminUserId }),
      idempotencyKey: key,
      endpoint,
      requestHash,
      state: 'in_progress',
      expiresAt: new Date(Date.now() + RETENTION_MS),
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });

  const recordId = inserted[0]?.id;
  if (recordId != null) {
    request.idempotencyRecordId = recordId;
    return null;
  }

  // 이미 같은 키가 있다. 상태에 따라 재생하거나 거부한다.
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.actorKey, actor.actorKey),
        eq(idempotencyKeys.endpoint, endpoint),
        eq(idempotencyKeys.idempotencyKey, key),
      ),
    )
    .limit(1);

  if (existing == null) {
    throw new AppError('STATE_CONFLICT');
  }

  if (existing.requestHash !== requestHash) {
    // 같은 키로 다른 내용을 보냈다. 클라이언트 버그이므로 상태를 바꾸지 않는다.
    throw new AppError('IDEMPOTENCY_KEY_REUSED');
  }

  if (existing.state === 'in_progress') {
    throw new AppError('STATE_CONFLICT');
  }

  return {
    status: existing.responseStatus ?? 200,
    body: existing.responseBody ?? null,
  };
}

/** 핸들러가 성공한 뒤 응답을 저장한다. 실패하면 선점 레코드를 지워 재시도를 허용한다. */
export async function completeIdempotentRequest(
  request: FastifyRequest,
  response: StoredResponse,
): Promise<void> {
  const recordId = request.idempotencyRecordId;
  if (recordId == null) return;

  await db
    .update(idempotencyKeys)
    .set({
      state: 'completed',
      responseStatus: response.status,
      responseBody: response.body,
    })
    .where(eq(idempotencyKeys.id, recordId));
}

export async function abortIdempotentRequest(request: FastifyRequest): Promise<void> {
  const recordId = request.idempotencyRecordId;
  if (recordId == null) return;

  // 실패한 요청까지 키에 묶어두면 사용자가 영원히 재시도할 수 없다.
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, recordId));
  request.idempotencyRecordId = undefined;
}

/** 저장된 응답을 그대로 돌려준다. */
export async function replay(reply: FastifyReply, stored: StoredResponse): Promise<void> {
  await reply.status(stored.status).header('idempotent-replay', 'true').send(stored.body);
}
