import process from 'node:process';
import postgres from 'postgres';
import { env } from '../config/env.ts';

/**
 * 개발용 seed.
 *
 * 안전 규칙 (09 §5, 07 §4):
 * - APP_ENV 가 dev 가 아니면 실행을 거부한다.
 * - 문항은 draft 로만 넣는다. 검수되지 않은 콘텐츠가 출제 풀에 들어가면 안 된다.
 * - 문항 본문에 [DEV SEED] 를 붙여 화면에 뜨는 즉시 알아볼 수 있게 한다.
 * - 시험 일정은 실제 공식 값을 넣되 출처와 확인 시각을 함께 기록한다.
 *   출시 직전 공식 사이트에서 다시 확인해야 한다 (07 §6, 09 §3).
 *
 * 여러 번 실행해도 같은 상태가 되도록 작성한다.
 */
async function main(): Promise<void> {
  if (env.APP_ENV !== 'dev') {
    throw new Error(`seed 는 dev 환경에서만 실행할 수 있습니다 (현재: ${env.APP_ENV})`);
  }

  const sql = postgres(env.DATABASE_URL, { max: 1 });

  try {
    await sql.begin(async (tx) => {
      // 1. 개발용 검수자 계정 --------------------------------------------------
      const [admin] = await tx<{ id: string }[]>`
        insert into admin_users (email, display_name, role)
        values ('dev-reviewer@example.test', '[DEV SEED] 검수자', 'admin')
        on conflict (email) do update set display_name = excluded.display_name
        returning id
      `;
      const reviewerId = admin!.id;

      // 2. 공식 시험 일정 ------------------------------------------------------
      // 2026-08-14 기준 공식 안내값. 공개 출시 직전 재확인 대상이다.
      const schedules = [
        { round: 80, examDate: '2026-10-17' },
        { round: 81, examDate: '2026-11-28' },
      ];

      for (const schedule of schedules) {
        await tx`
          insert into exam_schedules (type, round, exam_date, status, source_url, source_verified_at)
          values (
            'advanced', ${schedule.round}, ${schedule.examDate}, 'scheduled',
            'https://www.historyexam.go.kr/', timestamptz '2026-08-14T00:00:00+09:00'
          )
          on conflict (type, round) do update
            set exam_date = excluded.exam_date,
                source_url = excluded.source_url,
                source_verified_at = excluded.source_verified_at
        `;
      }

      // 3. 기능 플래그 ---------------------------------------------------------
      // V1 광고는 없다 (05 §3). 푸시는 P1 이라 기본 off 로 두고 켤 수 있게만 만든다.
      const flags = [
        { key: 'daily_study', enabled: true, description: '오늘 5문제 학습 세션' },
        { key: 'push_notification', enabled: false, description: '기능성 알림 발송' },
        { key: 'in_app_ads', enabled: false, description: 'V1 미사용. 광고 노출 kill switch' },
        { key: 'ai_draft_generation', enabled: false, description: 'CMS 문항 AI 초안 생성' },
      ];

      for (const flag of flags) {
        await tx`
          insert into feature_flags (key, enabled, description)
          values (${flag.key}, ${flag.enabled}, ${flag.description})
          on conflict (key) do update set description = excluded.description
        `;
      }

      // 4. 개발용 문항 (draft 전용) --------------------------------------------
      const seedQuestions = [
        { era: 'goryeo', topic: 'politics', ability: 'fact', difficulty: 2 },
        { era: 'joseon_early', topic: 'culture', ability: 'chronology', difficulty: 2 },
        { era: 'joseon_late', topic: 'economy', ability: 'causation', difficulty: 3 },
        { era: 'enlightenment', topic: 'society', ability: 'comparison', difficulty: 2 },
        { era: 'japanese_occupation', topic: 'figure', ability: 'source_reading', difficulty: 3 },
        { era: 'modern', topic: 'politics', ability: 'chronology', difficulty: 1 },
      ];

      const [existing] = await tx<{ count: string }[]>`
        select count(*)::text as count from question_revisions where prompt like '[DEV SEED]%'
      `;

      if (existing!.count === '0') {
        for (const [index, seed] of seedQuestions.entries()) {
          const [question] = await tx<{ id: string }[]>`
            insert into questions (created_by) values (${reviewerId}) returning id
          `;

          await tx`
            insert into question_revisions (
              question_id, revision, status, era, topic, ability, difficulty,
              prompt, choices, correct_index, explanation, memory_keyword,
              source_refs, source_accessed_at, rights_type, rights_note, created_by
            ) values (
              ${question!.id}, 1, 'draft',
              ${seed.era}, ${seed.topic}, ${seed.ability}, ${seed.difficulty},
              ${`[DEV SEED] 개발용 더미 문항 ${index + 1}. 실제 학습 콘텐츠가 아닙니다.`},
              ${tx.json(['보기 1', '보기 2', '보기 3', '보기 4', '보기 5'])},
              0,
              '[DEV SEED] 개발용 더미 해설입니다. 검수를 거치지 않았습니다.',
              '개발용',
              ${tx.json([{ title: '개발용 더미 출처', url: 'https://example.test/dev-seed' }])},
              '2026-08-14',
              'self_created',
              '[DEV SEED] 권리 검토 대상 아님',
              ${reviewerId}
            )
          `;
        }
      }
    });

    console.log('[seed] 완료 (dev 전용)');
    console.log('[seed] 문항은 draft 상태이므로 출제되지 않습니다. 검수 후 publish 하세요.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error('[seed] 실패');
  console.error(error);
  process.exit(1);
});
