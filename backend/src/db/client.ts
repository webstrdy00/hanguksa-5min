import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.ts';
import * as schema from './schema/index.ts';

/**
 * PostgreSQL 연결 (공통 02 §1).
 *
 * postgres.js 는 첫 쿼리 시점에 연결한다. import 만으로 커넥션이 열리지 않는다.
 * 세션 타임존을 UTC 로 고정해 서버 로케일과 무관하게 timestamptz 를 다룬다.
 * 일자 경계 계산은 DB 가 아니라 애플리케이션의 KST 유틸에서만 한다.
 */
export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  types: {},
  connection: {
    application_name: `${env.APP_NAME}-backend`,
    TimeZone: 'UTC',
  },
});

export const db = drizzle(sql, { schema });

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

/** readiness probe 용 최소 쿼리. */
export async function pingDb(): Promise<void> {
  await sql`select 1`;
}
