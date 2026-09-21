import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

function connect(url: string) {
  return postgres(url, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 20,
    onnotice: () => {},
    connection: { statement_timeout: 30000, lock_timeout: 10000, TimeZone: 'UTC' },
  });
}

/** 명시 CLI 전용. 일반 기동은 빈 원장을 자동 생성하지 않는다. */
export async function migrateJournal(url: string): Promise<void> {
  const connection = connect(url);
  try {
    await migrate(drizzle(connection), {
      migrationsFolder: fileURLToPath(new URL('../../journal-migrations', import.meta.url)),
    });
  } catch {
    throw new Error('DELETION_JOURNAL_MIGRATION_FAILED');
  } finally {
    await connection.end({ timeout: 5 });
  }
}

/**
 * 삭제 큐 쓰기를 DB lock으로 동결한 상태에서 과거 요청을 전수 이관한다.
 * 원장 commit 후 main fence commit이 실패해도 원장을 되돌리지 않는다.
 * 재실행은 기존 UUID binding을 확인하고 누락분을 보충하므로 빈 원장 재바인딩이 없다.
 */
export async function adoptJournal(
  mainUrl: string,
  journalUrl: string,
  journalId: string,
): Promise<{ importedSubjects: number }> {
  journalId = journalId.toLowerCase();
  const main = connect(mainUrl);
  const journal = connect(journalUrl);
  try {
    return await main.begin(async (tx) => {
      await tx`lock table deletion_jobs in share row exclusive mode`;
      const [state] = await tx<{ dataset_id: string; journal_enforced: boolean }[]>`
        select dataset_id, journal_enforced from deletion_restore_state where id = 1 for update
      `;
      if (!state) throw new Error('MISSING_DATASET_IDENTITY');
      const history = await tx<{ user_id: string; requested_at: Date }[]>`
        select subject_user_id as user_id, min(requested_at) as requested_at
        from deletion_jobs group by subject_user_id order by min(requested_at), subject_user_id
      `;
      // 삭제 표시만 있고 job이 없는 과거 데이터는 완전성 검증 실패로 간주한다.
      const [orphan] = await tx`
        select 1 from users u where identity_status = 'deleted'
        and not exists (select 1 from deletion_jobs j where j.subject_user_id = u.id) limit 1
      `;
      if (orphan) throw new Error('INCOMPLETE_HISTORICAL_DELETIONS');
      await journal.begin(async (ledger) => {
        await ledger`select pg_advisory_xact_lock(508217493)`;
        await ledger`
          insert into journal_metadata (id, journal_id, dataset_id, initialized, entry_count)
          values (1, ${journalId}::uuid, ${state.dataset_id}::uuid, false, 0)
          on conflict (id) do nothing
        `;
        const [metadata] = await ledger<
          { journal_id: string; dataset_id: string; entry_count: number }[]
        >`
          select journal_id, dataset_id, entry_count from journal_metadata where id = 1 for update
        `;
        if (
          !metadata ||
          metadata.journal_id !== journalId ||
          metadata.dataset_id !== state.dataset_id
        ) {
          throw new Error('JOURNAL_IDENTITY_MISMATCH');
        }
        let count = metadata.entry_count;
        for (const subject of history) {
          const [existing] = await ledger<{ requested_at: Date }[]>`
            select requested_at from journal_entries where subject_user_id = ${subject.user_id}::uuid
          `;
          if (existing) {
            if (existing.requested_at.getTime() > subject.requested_at.getTime()) {
              throw new Error('HISTORICAL_REQUEST_TIMESTAMP_MISMATCH');
            }
            continue;
          }
          count += 1;
          await ledger`
            insert into journal_entries (subject_user_id, requested_at, ordinal)
            values (${subject.user_id}::uuid, ${subject.requested_at.toISOString()}::timestamptz, ${count})
          `;
        }
        const [physical] = await ledger<{ count: number; maximum: number }[]>`
          select count(*)::int as count, coalesce(max(ordinal), 0) as maximum from journal_entries
        `;
        if (!physical || physical.count !== count || physical.maximum !== count) {
          throw new Error('JOURNAL_INCOMPLETE');
        }
        await ledger`update journal_metadata set entry_count = ${count}, initialized = true where id = 1`;
      });
      // 이전 버전 프로세스는 이후 deletion_jobs INSERT 시 실패/롤백한다.
      await tx`update deletion_restore_state set journal_enforced = true where id = 1`;
      return { importedSubjects: history.length };
    });
  } catch {
    throw new Error('DELETION_JOURNAL_ADOPTION_FAILED');
  } finally {
    await Promise.all([main.end({ timeout: 5 }), journal.end({ timeout: 5 })]);
  }
}
