import postgres from 'postgres';
import { env } from '../config/env.ts';

/**
 * DB 통합 테스트용 헬퍼.
 * 운영 코드에서는 사용하지 않는다. (*.db.test.ts 전용)
 */

/** 트랜잭션 안팎 어디서든 쓸 수 있는 쿼리 실행기. */
export type SqlLike = postgres.Sql | postgres.TransactionSql;

export function createTestClient(): postgres.Sql {
  return postgres(env.DATABASE_URL, { max: 2, onnotice: () => undefined });
}

/** 테스트 사이에 모든 업무 테이블을 비운다. */
export async function truncateAll(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    truncate table
      answers,
      study_session_items,
      study_sessions,
      user_question_state,
      mastery,
      question_reports,
      correction_notices,
      question_revisions,
      questions,
      notification_consents,
      idempotency_keys,
      deletion_jobs,
      admin_audit_logs,
      feature_flags,
      users,
      exam_schedule_audits,
      exam_schedules,
      admin_users
    restart identity cascade
  `);
}

export async function insertAdmin(
  sql: postgres.Sql,
  email = 'reviewer@example.test',
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into admin_users (email, display_name, role)
    values (${email}, '검수자', 'reviewer')
    returning id
  `;
  return rows[0]!.id;
}

export async function insertUser(sql: postgres.Sql, fingerprint: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into users (anon_key_fingerprint, identity_verified_at)
    values (${fingerprint}, now())
    returning id
  `;
  return rows[0]!.id;
}

export async function insertQuestion(sql: postgres.Sql): Promise<string> {
  const rows = await sql<{ id: string }[]>`insert into questions default values returning id`;
  return rows[0]!.id;
}

/**
 * interface 로 선언하면 암시적 index signature 가 없어 postgres.js 의 JSONValue 에 들어가지 않는다.
 * type alias 로 둔다.
 */
type SourceRef = { title: string; url: string };

interface RevisionOptions {
  questionId: string;
  reviewerId: string;
  revision?: number;
  status?: string;
  era?: string;
  topic?: string;
  choiceCount?: number;
  sourceRefs?: SourceRef[];
}

/** 기본값은 "발행 가능한 정상 문항"이다. 각 테스트는 필요한 값만 바꾼다. */
export async function insertRevision(sql: postgres.Sql, options: RevisionOptions): Promise<string> {
  const {
    questionId,
    reviewerId,
    revision = 1,
    status = 'published',
    era = 'goryeo',
    topic = 'politics',
    choiceCount = 5,
    sourceRefs = [{ title: '국사편찬위원회', url: 'https://www.history.go.kr/' }],
  } = options;

  const choices = Array.from({ length: choiceCount }, (_, index) => `선택지 ${index + 1}`);

  const rows = await sql<{ id: string }[]>`
    insert into question_revisions (
      question_id, revision, status, era, topic, ability, difficulty,
      prompt, choices, correct_index, explanation,
      source_refs, source_accessed_at, rights_type, reviewer_id, reviewed_at
    ) values (
      ${questionId}, ${revision}, ${status}, ${era}, ${topic}, 'fact', 2,
      '다음 설명에 해당하는 제도는?', ${sql.json(choices)}, 0, '정답 근거 해설',
      ${sql.json(sourceRefs)}, '2026-08-14', 'self_created', ${reviewerId}, now()
    )
    returning id
  `;
  return rows[0]!.id;
}

export async function insertSession(
  sql: SqlLike,
  userId: string,
  studyDate: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into study_sessions (user_id, study_date)
    values (${userId}, ${studyDate})
    returning id
  `;
  return rows[0]!.id;
}

/** 세션에 5개 슬롯을 채운다. 07 §2 기본 구성(복습 2 + 취약 1 + 신규 2). */
export async function fillSessionItems(
  sql: SqlLike,
  sessionId: string,
  items: { revisionId: string; questionId: string }[],
): Promise<void> {
  const sources = ['review', 'review', 'weak', 'new', 'new'];
  for (const [index, item] of items.entries()) {
    await sql`
      insert into study_session_items
        (session_id, question_revision_id, canonical_question_id, slot_index, slot_source)
      values (${sessionId}, ${item.revisionId}, ${item.questionId}, ${index}, ${sources[index] ?? 'new'})
    `;
  }
}

/** 문항 5개와 revision 5개를 한 번에 만든다. */
export async function createQuestionPool(
  sql: postgres.Sql,
  reviewerId: string,
  count = 5,
): Promise<{ revisionId: string; questionId: string }[]> {
  const pool: { revisionId: string; questionId: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const questionId = await insertQuestion(sql);
    const revisionId = await insertRevision(sql, { questionId, reviewerId });
    pool.push({ questionId, revisionId });
  }
  return pool;
}
