import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeletionJournalStore, type DeletionJournalStore } from './store.ts';

// No database connection is made: every operation below must reject before issuing SQL.
const DATABASE_URL = 'postgres://journal@127.0.0.1:1/deletion_journal';
const JOURNAL_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const UNAVAILABLE = new Error('DELETION_JOURNAL_UNAVAILABLE');

describe('deletion journal input boundary', () => {
  let store: DeletionJournalStore;

  beforeEach(() => {
    store = createDeletionJournalStore(DATABASE_URL, JOURNAL_ID);
  });

  afterEach(async () => {
    await store.close();
  });

  it.each(['', 'not-a-uuid', `${JOURNAL_ID}x`, `{${JOURNAL_ID}}`])(
    'rejects a malformed pinned journal UUID without exposing it',
    (journalId) => {
      expect(() => createDeletionJournalStore(DATABASE_URL, journalId)).toThrow(UNAVAILABLE);
    },
  );

  it.each(['', ' ', 'not-a-url', 'https://example.com/journal', 'postgres://%/journal'])(
    'rejects invalid database locations with a sanitized error',
    (databaseUrl) => {
      expect(() => createDeletionJournalStore(databaseUrl, JOURNAL_ID)).toThrow(UNAVAILABLE);
    },
  );

  it.each(['', 'raw-anonymous-key', `${USER_ID}x`, USER_ID.replaceAll('-', ''), `${USER_ID}\n`])(
    'rejects non-UUID subjects for both read and append',
    async (userId) => {
      await expect(store.has(userId)).rejects.toEqual(UNAVAILABLE);
      await expect(store.append(userId, new Date())).rejects.toEqual(UNAVAILABLE);
      let called = false;
      await expect(
        store.withActiveSubject(userId, () => {
          called = true;
          return Promise.resolve();
        }),
      ).rejects.toEqual(UNAVAILABLE);
      expect(called).toBe(false);
    },
  );

  it('rejects an invalid request date before opening a connection', async () => {
    await expect(store.append(USER_ID, new Date(Number.NaN))).rejects.toEqual(UNAVAILABLE);
    await expect(store.append(USER_ID, new Date(Number.POSITIVE_INFINITY))).rejects.toEqual(
      UNAVAILABLE,
    );
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid ordinal cursors',
    async (cursor) => {
      await expect(store.list(cursor, 100)).rejects.toEqual(UNAVAILABLE);
    },
  );

  it.each([0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects limits outside the bounded integer range',
    async (limit) => {
      await expect(store.list(0, limit)).rejects.toEqual(UNAVAILABLE);
    },
  );
});
