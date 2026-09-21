import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Provisioned and adopted by an operator, never initialized by the runtime. */
export const journalMetadata = pgTable(
  'journal_metadata',
  {
    id: integer('id').primaryKey(),
    journalId: uuid('journal_id').notNull().unique(),
    datasetId: uuid('dataset_id').notNull(),
    initialized: boolean('initialized').notNull().default(false),
    entryCount: integer('entry_count').notNull().default(0),
  },
  (t) => [
    check('journal_metadata_singleton_check', sql`${t.id} = 1`),
    check('journal_metadata_entry_count_check', sql`${t.entryCount} >= 0`),
  ],
);

/** Deliberately excludes identity fingerprints, credentials, and raw anonymous keys. */
export const journalEntries = pgTable(
  'journal_entries',
  {
    subjectUserId: uuid('subject_user_id').primaryKey(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    ordinal: integer('ordinal').notNull().unique(),
  },
  (t) => [check('journal_entries_ordinal_check', sql`${t.ordinal} > 0`)],
);
