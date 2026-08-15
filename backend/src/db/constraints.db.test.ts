import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createQuestionPool,
  createTestClient,
  fillSessionItems,
  insertAdmin,
  insertQuestion,
  insertRevision,
  insertSession,
  insertUser,
  truncateAll,
} from './test-helpers.ts';

/**
 * DB 제약이 실제로 동작하는지 검증한다.
 *
 * DDL 에 써놓는 것만으로는 의미가 없다. 위반이 정말 거부되는지 확인해야
 * "서버가 보장한다"고 말할 수 있다 (공통 02 §4, 08 §1).
 */
let sql: postgres.Sql;

beforeAll(() => {
  sql = createTestClient();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await truncateAll(sql);
});

describe('users', () => {
  it('anon_key_fingerprint 는 중복될 수 없다', async () => {
    await insertUser(sql, 'fingerprint-a');
    await expect(insertUser(sql, 'fingerprint-a')).rejects.toThrow(/unique/i);
  });

  it('목표 급수는 심화 1~3 만 허용한다', async () => {
    const userId = await insertUser(sql, 'fingerprint-grade');
    await expect(sql`update users set target_grade = 4 where id = ${userId}`).rejects.toThrow(
      /users_target_grade_check/,
    );

    await sql`update users set target_grade = 2 where id = ${userId}`;
    const [row] = await sql<{ target_grade: number }[]>`
      select target_grade from users where id = ${userId}
    `;
    expect(row?.target_grade).toBe(2);
  });

  it('anonKey 암호문과 키 버전은 함께 있어야 한다', async () => {
    const userId = await insertUser(sql, 'fingerprint-cipher');
    await expect(
      sql`update users set anon_key_ciphertext = 'enc' where id = ${userId}`,
    ).rejects.toThrow(/users_anon_key_ciphertext_pair_check/);

    await sql`
      update users set anon_key_ciphertext = 'enc', anon_key_key_version = 1 where id = ${userId}
    `;
  });

  it('삭제 상태와 삭제 시각이 어긋날 수 없다', async () => {
    const userId = await insertUser(sql, 'fingerprint-deleted');
    await expect(
      sql`update users set identity_status = 'deleted' where id = ${userId}`,
    ).rejects.toThrow(/users_deleted_at_check/);
  });

  it('updated_at 이 자동으로 갱신된다', async () => {
    const userId = await insertUser(sql, 'fingerprint-updated');
    const [before] = await sql<{ updated_at: Date }[]>`
      select updated_at from users where id = ${userId}
    `;

    await sql`update users set app_version = '1.0.1' where id = ${userId}`;

    const [after] = await sql<{ updated_at: Date }[]>`
      select updated_at from users where id = ${userId}
    `;
    expect(after!.updated_at.getTime()).toBeGreaterThanOrEqual(before!.updated_at.getTime());
  });
});

describe('exam_schedules', () => {
  it('같은 종류의 회차는 중복될 수 없다', async () => {
    await sql`
      insert into exam_schedules (type, round, exam_date, source_url, source_verified_at)
      values ('advanced', 80, '2026-10-17', 'https://www.historyexam.go.kr/', now())
    `;

    await expect(sql`
      insert into exam_schedules (type, round, exam_date, source_url, source_verified_at)
      values ('advanced', 80, '2026-10-18', 'https://www.historyexam.go.kr/', now())
    `).rejects.toThrow(/unique/i);
  });

  it('출처 URL 없이 등록할 수 없다', async () => {
    await expect(sql`
      insert into exam_schedules (type, round, exam_date, source_url, source_verified_at)
      values ('advanced', 81, '2026-11-28', '', now())
    `).rejects.toThrow(/exam_schedules_source_url_check/);
  });

  it('정의되지 않은 상태값을 거부한다', async () => {
    await expect(sql`
      insert into exam_schedules (type, round, exam_date, status, source_url, source_verified_at)
      values ('advanced', 82, '2026-12-19', 'held', 'https://www.historyexam.go.kr/', now())
    `).rejects.toThrow(/exam_schedules_status_check/);
  });
});

describe('question_revisions', () => {
  let reviewerId: string;

  beforeEach(async () => {
    reviewerId = await insertAdmin(sql);
  });

  it('선택지는 정확히 5개여야 한다', async () => {
    const questionId = await insertQuestion(sql);
    await expect(insertRevision(sql, { questionId, reviewerId, choiceCount: 4 })).rejects.toThrow(
      /question_revisions_choices_check/,
    );
  });

  it('출처 없이 published 로 만들 수 없다', async () => {
    const questionId = await insertQuestion(sql);
    await expect(insertRevision(sql, { questionId, reviewerId, sourceRefs: [] })).rejects.toThrow(
      /question_revisions_publish_requirements_check/,
    );
  });

  it('검수자 없이 published 로 만들 수 없다', async () => {
    const questionId = await insertQuestion(sql);
    await expect(sql`
      insert into question_revisions (
        question_id, revision, status, era, topic, ability, difficulty,
        prompt, choices, correct_index, explanation,
        source_refs, source_accessed_at, rights_type
      ) values (
        ${questionId}, 1, 'published', 'goryeo', 'politics', 'fact', 2,
        '문항', ${sql.json(['1', '2', '3', '4', '5'])}, 0, '해설',
        ${sql.json([{ url: 'https://example.test' }])}, '2026-08-14', 'self_created'
      )
    `).rejects.toThrow(/question_revisions_publish_requirements_check/);
  });

  it('검수 메타 없이도 draft 로는 저장할 수 있다', async () => {
    const questionId = await insertQuestion(sql);
    await sql`
      insert into question_revisions (
        question_id, revision, status, era, topic, ability, difficulty,
        prompt, choices, correct_index, explanation
      ) values (
        ${questionId}, 1, 'draft', 'modern', 'society', 'fact', 1,
        '초안 문항', ${sql.json(['1', '2', '3', '4', '5'])}, 0, '초안 해설'
      )
    `;
  });

  it('한 문항에 published revision 은 하나뿐이다', async () => {
    const questionId = await insertQuestion(sql);
    await insertRevision(sql, { questionId, reviewerId, revision: 1 });

    await expect(insertRevision(sql, { questionId, reviewerId, revision: 2 })).rejects.toThrow(
      /question_revisions_one_published_idx/,
    );
  });

  it('같은 revision 번호를 두 번 쓸 수 없다', async () => {
    const questionId = await insertQuestion(sql);
    await insertRevision(sql, { questionId, reviewerId, revision: 1 });
    await expect(
      insertRevision(sql, { questionId, reviewerId, revision: 1, status: 'retired' }),
    ).rejects.toThrow(/unique/i);
  });

  it('내용은 수정할 수 없다 (immutable)', async () => {
    const questionId = await insertQuestion(sql);
    const revisionId = await insertRevision(sql, { questionId, reviewerId });

    await expect(
      sql`update question_revisions set prompt = '몰래 고친 문항' where id = ${revisionId}`,
    ).rejects.toThrow(/immutable/i);

    await expect(
      sql`update question_revisions set era = 'modern' where id = ${revisionId}`,
    ).rejects.toThrow(/immutable/i);

    await expect(
      sql`update question_revisions set correct_index = 3 where id = ${revisionId}`,
    ).rejects.toThrow(/immutable/i);
  });

  it('상태 전이는 허용한다 (retire / void)', async () => {
    const questionId = await insertQuestion(sql);
    const revisionId = await insertRevision(sql, { questionId, reviewerId });

    await sql`
      update question_revisions
      set status = 'voided', status_reason = '사실 오류', status_changed_at = now()
      where id = ${revisionId}
    `;

    const [row] = await sql<{ status: string }[]>`
      select status from question_revisions where id = ${revisionId}
    `;
    expect(row?.status).toBe('voided');
  });

  it('draft 가 아닌 revision 은 삭제할 수 없다', async () => {
    const questionId = await insertQuestion(sql);
    const revisionId = await insertRevision(sql, { questionId, reviewerId });

    await expect(sql`delete from question_revisions where id = ${revisionId}`).rejects.toThrow(
      /can only be deleted while draft/,
    );
  });
});

describe('study_sessions / study_session_items', () => {
  let reviewerId: string;
  let userId: string;

  beforeEach(async () => {
    reviewerId = await insertAdmin(sql);
    userId = await insertUser(sql, 'fingerprint-session');
  });

  it('하루에 세션은 하나만 만들 수 있다', async () => {
    await insertSession(sql, userId, '2026-08-15');
    await expect(insertSession(sql, userId, '2026-08-15')).rejects.toThrow(/unique/i);
  });

  it('세트가 5문항이 아니면 커밋되지 않는다', async () => {
    const pool = await createQuestionPool(sql, reviewerId, 4);

    await expect(
      sql.begin(async (tx) => {
        const sessionId = await insertSession(tx, userId, '2026-08-16');
        await fillSessionItems(tx, sessionId, pool);
      }),
    ).rejects.toThrow(/must have exactly 5 items/);

    const rows = await sql`select id from study_sessions where user_id = ${userId}`;
    expect(rows).toHaveLength(0);
  });

  it('세트가 5문항이면 커밋된다', async () => {
    const pool = await createQuestionPool(sql, reviewerId, 5);

    await sql.begin(async (tx) => {
      const sessionId = await insertSession(tx, userId, '2026-08-17');
      await fillSessionItems(tx, sessionId, pool);
    });

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from study_session_items
    `;
    expect(row?.count).toBe('5');
  });

  it('같은 문항을 한 세션에 두 번 배정할 수 없다', async () => {
    const pool = await createQuestionPool(sql, reviewerId, 5);
    const duplicated = [...pool.slice(0, 4), pool[0]!];

    await expect(
      sql.begin(async (tx) => {
        const sessionId = await insertSession(tx, userId, '2026-08-18');
        await fillSessionItems(tx, sessionId, duplicated);
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('완료 시각과 점수는 함께 확정된다', async () => {
    const pool = await createQuestionPool(sql, reviewerId, 5);
    let sessionId = '';
    await sql.begin(async (tx) => {
      sessionId = await insertSession(tx, userId, '2026-08-19');
      await fillSessionItems(tx, sessionId, pool);
    });

    await expect(sql`update study_sessions set score = 4 where id = ${sessionId}`).rejects.toThrow(
      /study_sessions_completion_pair_check/,
    );

    await sql`update study_sessions set score = 4, completed_at = now() where id = ${sessionId}`;
  });
});

describe('answers', () => {
  let reviewerId: string;
  let userId: string;
  let sessionId: string;
  let pool: { revisionId: string; questionId: string }[];

  beforeEach(async () => {
    reviewerId = await insertAdmin(sql);
    userId = await insertUser(sql, 'fingerprint-answer');
    pool = await createQuestionPool(sql, reviewerId, 5);
    await sql.begin(async (tx) => {
      sessionId = await insertSession(tx, userId, '2026-08-20');
      await fillSessionItems(tx, sessionId, pool);
    });
  });

  async function submitAnswer(revisionId: string, selectedIndex = 0): Promise<void> {
    await sql`
      insert into answers (session_id, question_revision_id, selected_index, is_correct)
      values (${sessionId}, ${revisionId}, ${selectedIndex}, true)
    `;
  }

  it('한 문항에는 한 번만 답할 수 있다', async () => {
    await submitAnswer(pool[0]!.revisionId);
    await expect(submitAnswer(pool[0]!.revisionId, 1)).rejects.toThrow(/unique/i);
  });

  it('제출한 답은 수정할 수 없다', async () => {
    await submitAnswer(pool[1]!.revisionId);
    await expect(
      sql`update answers set selected_index = 4 where session_id = ${sessionId}`,
    ).rejects.toThrow(/answers are immutable/);
  });

  it('세션에 배정되지 않은 문항에는 답할 수 없다', async () => {
    const outsideQuestionId = await insertQuestion(sql);
    const outsideRevisionId = await insertRevision(sql, {
      questionId: outsideQuestionId,
      reviewerId,
    });

    await expect(submitAnswer(outsideRevisionId)).rejects.toThrow(/foreign key/i);
  });

  it('선택지 범위를 벗어난 답을 거부한다', async () => {
    await expect(submitAnswer(pool[2]!.revisionId, 5)).rejects.toThrow(
      /answers_selected_index_check/,
    );
  });
});

describe('mastery / user_question_state', () => {
  let userId: string;

  beforeEach(async () => {
    userId = await insertUser(sql, 'fingerprint-mastery');
  });

  it('정답 수가 노출 수보다 클 수 없다', async () => {
    await expect(sql`
      insert into mastery (user_id, era, topic, seen_count, correct_count)
      values (${userId}, 'goryeo', 'politics', 3, 5)
    `).rejects.toThrow(/mastery_counts_check/);
  });

  it('정의되지 않은 시대를 거부한다', async () => {
    await expect(sql`
      insert into mastery (user_id, era, topic) values (${userId}, 'silla', 'politics')
    `).rejects.toThrow(/mastery_era_check/);
  });

  it('사용자-문항 복습 상태는 하나만 존재한다', async () => {
    const questionId = await insertQuestion(sql);
    await sql`
      insert into user_question_state (user_id, canonical_question_id, last_result, last_seen_at)
      values (${userId}, ${questionId}, 'wrong', now())
    `;

    await expect(sql`
      insert into user_question_state (user_id, canonical_question_id, last_result, last_seen_at)
      values (${userId}, ${questionId}, 'correct', now())
    `).rejects.toThrow(/duplicate key/i);
  });

  it('복습 간격 단계는 0~3 범위다', async () => {
    const questionId = await insertQuestion(sql);
    await expect(sql`
      insert into user_question_state
        (user_id, canonical_question_id, last_result, last_seen_at, interval_step)
      values (${userId}, ${questionId}, 'wrong', now(), 4)
    `).rejects.toThrow(/user_question_state_interval_step_check/);
  });
});

describe('개인정보 삭제 파급 (09 §6)', () => {
  it('사용자를 지우면 학습 데이터는 함께 사라지고 콘텐츠 이력은 남는다', async () => {
    const reviewerId = await insertAdmin(sql);
    const userId = await insertUser(sql, 'fingerprint-erase');
    const pool = await createQuestionPool(sql, reviewerId, 5);

    let sessionId = '';
    await sql.begin(async (tx) => {
      sessionId = await insertSession(tx, userId, '2026-08-21');
      await fillSessionItems(tx, sessionId, pool);
    });

    await sql`
      insert into answers (session_id, question_revision_id, selected_index, is_correct)
      values (${sessionId}, ${pool[0]!.revisionId}, 0, true)
    `;
    await sql`
      insert into mastery (user_id, era, topic, seen_count, correct_count)
      values (${userId}, 'goryeo', 'politics', 5, 3)
    `;
    await sql`
      insert into user_question_state (user_id, canonical_question_id, last_result, last_seen_at)
      values (${userId}, ${pool[0]!.questionId}, 'correct', now())
    `;
    await sql`
      insert into question_reports (question_revision_id, reporter_user_id, reason, detail)
      values (${pool[0]!.revisionId}, ${userId}, 'ambiguous', '보기가 애매해요')
    `;
    await sql`
      insert into notification_consents (user_id, functional_agreed, functional_agreed_at)
      values (${userId}, true, now())
    `;

    await sql`delete from users where id = ${userId}`;

    const remaining = await sql<{ table_name: string; count: string }[]>`
      select 'study_sessions' as table_name, count(*)::text as count from study_sessions
      union all select 'answers', count(*)::text from answers
      union all select 'mastery', count(*)::text from mastery
      union all select 'user_question_state', count(*)::text from user_question_state
      union all select 'notification_consents', count(*)::text from notification_consents
      union all select 'question_revisions', count(*)::text from question_revisions
      union all select 'question_reports', count(*)::text from question_reports
    `;

    const counts = Object.fromEntries(remaining.map((row) => [row.table_name, row.count]));

    // 개인 학습 데이터는 사라진다
    expect(counts['study_sessions']).toBe('0');
    expect(counts['answers']).toBe('0');
    expect(counts['mastery']).toBe('0');
    expect(counts['user_question_state']).toBe('0');
    expect(counts['notification_consents']).toBe('0');

    // 콘텐츠와 신고 이력은 남는다 (신고자만 익명화)
    expect(counts['question_revisions']).toBe('5');
    expect(counts['question_reports']).toBe('1');

    const [report] = await sql<{ reporter_user_id: string | null }[]>`
      select reporter_user_id from question_reports
    `;
    expect(report?.reporter_user_id).toBeNull();
  });
});
