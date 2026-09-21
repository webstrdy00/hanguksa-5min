import process from 'node:process';
import { defineConfig } from 'drizzle-kit';

/** Separate PostgreSQL project: never use the operational DATABASE_URL here. */
export default defineConfig({
  schema: './src/deletion-journal/schema.ts',
  out: './journal-migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DELETION_JOURNAL_DATABASE_URL'] ?? '',
  },
  strict: true,
  verbose: false,
});
