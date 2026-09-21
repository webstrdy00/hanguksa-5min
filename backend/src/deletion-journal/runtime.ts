import { eq } from 'drizzle-orm';
import { env } from '../config/env.ts';
import { db } from '../db/client.ts';
import { deletionRestoreState } from '../db/schema/ops.ts';
import { AppError } from '../http/errors.ts';
import { createDeletionJournalStore } from './store.ts';

const journal =
  env.DELETION_JOURNAL_DATABASE_URL != null && env.DELETION_JOURNAL_ID != null
    ? createDeletionJournalStore(env.DELETION_JOURNAL_DATABASE_URL, env.DELETION_JOURNAL_ID)
    : null;

/** 원장 미설정은 로컬 dev만 허용한다. 운영/staging은 env 검증에서 거부한다. */
export function getDeletionJournal() {
  return journal;
}

export async function assertDeletionJournalBinding(): Promise<void> {
  if (journal == null) return;
  try {
    const metadata = await journal.inspect();
    const [state] = await db
      .select()
      .from(deletionRestoreState)
      .where(eq(deletionRestoreState.id, 1));
    if (
      state == null ||
      !state.journalEnforced ||
      state.datasetId !== metadata.datasetId ||
      state.replayedOrdinal > metadata.entryCount
    ) {
      throw new Error('DELETION_JOURNAL_BINDING_MISMATCH');
    }
  } catch {
    throw new AppError('DEPENDENCY_UNAVAILABLE');
  }
}

export async function recordDeletionIntent(userId: string, requestedAt: Date): Promise<void> {
  if (journal == null) return;
  try {
    await assertDeletionJournalBinding();
    await journal.append(userId, requestedAt);
  } catch {
    throw new AppError('DEPENDENCY_UNAVAILABLE');
  }
}

/** main DB 반영 실패 후에도 외부에 접수된 탈퇴 대상은 인증·발송에 사용할 수 없다. */
export async function isDeletionRequested(userId: string): Promise<boolean> {
  if (journal == null) return false;
  try {
    return await journal.has(userId);
  } catch {
    throw new AppError('DEPENDENCY_UNAVAILABLE');
  }
}

export async function closeDeletionJournal(): Promise<void> {
  await journal?.close();
}

export async function withLiveJournalSubject<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (journal == null) return await operation();
  try {
    return await journal.withActiveSubject(userId, operation);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message === 'DELETION_JOURNAL_SUBJECT_DELETED') {
      throw new AppError('USER_DELETED');
    }
    throw new AppError('DEPENDENCY_UNAVAILABLE');
  }
}
