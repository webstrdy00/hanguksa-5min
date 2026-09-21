import postgres from 'postgres';

export interface DeletionJournalMetadata {
  journalId: string;
  datasetId: string;
  initialized: boolean;
  entryCount: number;
}

export interface DeletionJournalEntry {
  userId: string;
  requestedAt: Date;
  ordinal: number;
}

export interface DeletionJournalStore {
  /** Checks the pinned journal and its complete, contiguous physical history. */
  inspect(): Promise<DeletionJournalMetadata>;
  /** Idempotent by user UUID; the first request timestamp and ordinal are immutable. */
  append(userId: string, requestedAt: Date): Promise<DeletionJournalEntry>;
  has(userId: string): Promise<boolean>;
  /** Serializes protected work with deletion; callback errors retain their original identity. */
  withActiveSubject<T>(userId: string, operation: () => Promise<T>): Promise<T>;
  /** Ascending exclusive cursor; limit must be an integer in 1..1000. */
  list(afterOrdinal: number, limit: number): Promise<DeletionJournalEntry[]>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ENTRY_COUNT = 2_147_483_647;

function unavailable(): Error {
  // Never attach the original error: driver errors can contain credentials and SQL values.
  return new Error('DELETION_JOURNAL_UNAVAILABLE');
}

function validUuid(value: string): boolean {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}

async function sanitized<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw unavailable();
  }
}

/** Connects lazily; it never creates tables, metadata, or an empty replacement journal. */
export function createDeletionJournalStore(
  databaseUrl: string,
  expectedJournalId: string,
): DeletionJournalStore {
  if (!validUuid(expectedJournalId) || typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw unavailable();
  }

  let sql: postgres.Sql;
  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
      throw unavailable();
    }
    // postgres.js URL connection parameters override the connection options object.
    url.searchParams.set('statement_timeout', '10000');
    sql = postgres(url.toString(), {
      connect_timeout: 10,
      idle_timeout: 20,
      max: 2,
      debug: false,
      connection: {
        statement_timeout: 10_000,
        TimeZone: 'UTC',
      },
      // postgres.js prints server notices by default; do not expose server text.
      onnotice: () => {},
    });
  } catch {
    throw unavailable();
  }
  const pinnedJournalId = expectedJournalId.toLowerCase();

  async function lockSubject(transaction: postgres.TransactionSql, userId: string): Promise<void> {
    // Canonicalize UUID case so all callers lock the same subject before metadata or main DB work.
    await transaction`
      select pg_advisory_xact_lock(hashtextextended(${userId.toLowerCase()}, 0))
    `;
  }

  async function metadata(
    transaction: postgres.TransactionSql,
    lock: 'share' | 'update' | 'none' = 'share',
  ): Promise<DeletionJournalMetadata> {
    const rows = await transaction<DeletionJournalMetadata[]>`
      select journal_id as "journalId", dataset_id as "datasetId",
             initialized, entry_count as "entryCount"
      from journal_metadata where id = 1
      ${lock === 'update' ? transaction`for update` : lock === 'share' ? transaction`for share` : transaction``}
    `;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.journalId !== pinnedJournalId ||
      !validUuid(row.datasetId) ||
      row.initialized !== true ||
      !Number.isInteger(row.entryCount) ||
      row.entryCount < 0 ||
      row.entryCount > MAX_ENTRY_COUNT
    ) {
      throw unavailable();
    }
    return row;
  }

  return {
    inspect: () =>
      sanitized(() =>
        sql.begin(async (transaction) => {
          // All writers lock this singleton before insertion, so counts cannot race append.
          const ready = await metadata(transaction);
          const [physical] = await transaction<{ count: string; maximum: number }[]>`
            select count(*)::text as count, coalesce(max(ordinal), 0) as maximum
            from journal_entries
          `;
          if (
            !physical ||
            Number(physical.count) !== ready.entryCount ||
            physical.maximum !== ready.entryCount
          ) {
            throw unavailable();
          }
          return ready;
        }),
      ),

    append: (userId, requestedAt) =>
      sanitized(async () => {
        if (
          !validUuid(userId) ||
          !(requestedAt instanceof Date) ||
          !Number.isFinite(requestedAt.getTime())
        ) {
          throw unavailable();
        }
        const timestamp = requestedAt.toISOString();
        return sql.begin(async (transaction) => {
          await lockSubject(transaction, userId);
          const ready = await metadata(transaction, 'update');
          const [existing] = await transaction<DeletionJournalEntry[]>`
            select subject_user_id as "userId", requested_at as "requestedAt", ordinal
            from journal_entries where subject_user_id = ${userId}::uuid
          `;
          if (existing) return existing;
          if (ready.entryCount === MAX_ENTRY_COUNT) throw unavailable();
          const [inserted] = await transaction<DeletionJournalEntry[]>`
            insert into journal_entries (subject_user_id, requested_at, ordinal)
            values (${userId}::uuid, ${timestamp}::timestamptz, ${ready.entryCount + 1})
            returning subject_user_id as "userId", requested_at as "requestedAt", ordinal
          `;
          if (!inserted) throw unavailable();
          await transaction`
            update journal_metadata set entry_count = ${ready.entryCount + 1} where id = 1
          `;
          return inserted;
        });
      }),

    async withActiveSubject<T>(userId: string, operation: () => Promise<T>): Promise<T> {
      if (!validUuid(userId)) throw unavailable();
      const subjectDeleted = new Error('DELETION_JOURNAL_SUBJECT_DELETED');
      let operationFailed = false;
      let operationError: unknown;
      try {
        const completed = await sql.begin(async (transaction) => {
          await lockSubject(transaction, userId);
          // Binding/ready는 DB trigger로 불변이다. 다른 사용자의 삭제를 main 작업으로 막지 않는다.
          await metadata(transaction, 'none');
          const [result] = await transaction<{ present: boolean }[]>`
            select exists (
              select 1 from journal_entries where subject_user_id = ${userId}::uuid
            ) as present
          `;
          if (!result || typeof result.present !== 'boolean') throw unavailable();
          if (result.present) throw subjectDeleted;
          try {
            return { value: await operation() };
          } catch (error) {
            operationFailed = true;
            operationError = error;
            throw error;
          }
        });
        return completed.value;
      } catch (error) {
        if (error === subjectDeleted || (operationFailed && error === operationError)) throw error;
        // Includes failed BEGIN, COMMIT, lock acquisition, metadata reads, and tombstone reads.
        throw unavailable();
      }
    },

    has: (userId) =>
      sanitized(async () => {
        if (!validUuid(userId)) throw unavailable();
        return sql.begin(async (transaction) => {
          await metadata(transaction);
          const [result] = await transaction<{ present: boolean }[]>`
            select exists (
              select 1 from journal_entries where subject_user_id = ${userId}::uuid
            ) as present
          `;
          if (!result || typeof result.present !== 'boolean') throw unavailable();
          return result.present;
        });
      }),

    list: (afterOrdinal, limit) =>
      sanitized(async () => {
        if (
          !Number.isSafeInteger(afterOrdinal) ||
          afterOrdinal < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 1000
        ) {
          throw unavailable();
        }
        return sql.begin(async (transaction) => {
          await metadata(transaction);
          return transaction<DeletionJournalEntry[]>`
            select subject_user_id as "userId", requested_at as "requestedAt", ordinal
            from journal_entries where ordinal > ${afterOrdinal}::bigint
            order by ordinal asc limit ${limit}
          `;
        });
      }),

    close: () => sanitized(() => sql.end({ timeout: 5 })),
  };
}
