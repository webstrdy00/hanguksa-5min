import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../config/env.ts';

/**
 * migration 실행기 (공통 06 §5).
 *
 * - migration 파일은 Git 으로 관리하고 staging 에 먼저 적용한다.
 * - 파괴적 변경은 expand -> migrate -> contract 2단계로 나눈다 (공통 04 §6).
 * - 이 스크립트는 앞으로 이동(forward)만 한다. 되돌리기는 새 migration 으로 처리한다.
 */
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

async function main(): Promise<void> {
  // migration 은 순서 보장이 필요하므로 단일 커넥션으로 실행한다.
  const client = postgres(env.DATABASE_URL, { max: 1 });

  try {
    console.log(`[migrate] target=${env.APP_ENV} folder=${migrationsFolder}`);
    await migrate(drizzle(client), { migrationsFolder });
    console.log('[migrate] done');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error('[migrate] failed');
  console.error(error);
  process.exit(1);
});
