import process from 'node:process';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 설정.
 *
 * `pnpm db:generate` 는 스키마에서 SQL migration 파일을 만든다(DB 접속 불필요).
 * 실제 적용은 `pnpm db:migrate`(src/db/migrate.ts)가 담당한다.
 *
 * push 는 사용하지 않는다. 스키마 변경은 항상 Git 에 남는 migration 파일로만 반영한다.
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  strict: true,
  verbose: true,
});
