import { readFileSync } from 'node:fs';
import process from 'node:process';
import { issueAdminToken } from '../auth/admin-token.ts';
import { db } from '../db/client.ts';
import { adminUsers } from '../db/schema/admin.ts';
import { eq } from 'drizzle-orm';

/**
 * 문항 일괄 투입 (04 §3 파이프라인 ⑥, 11단계).
 *
 *   pnpm --filter @hanguksa/backend import:questions -- <파일.json> [--publish] [--base=URL]
 *
 * 300문항을 CMS 화면에서 손으로 넣지 않기 위한 도구다.
 * 관리자 API 를 그대로 호출하므로 상태 머신·필수 메타 검증을 모두 거친다.
 *
 * ⚠️ 기본 동작은 **draft 까지만** 만든다.
 *    `--publish` 를 줘야 review → approved → published 로 올린다.
 *    04 §4 와 01 §8 이 "AI 생성 문항 자동 게시 금지"를 요구하므로,
 *    사람이 검수한 파일에만 --publish 를 붙여야 한다.
 *
 * 입력 파일 형식 (JSON 배열):
 * [
 *   {
 *     "era": "goryeo", "topic": "politics", "ability": "fact", "difficulty": 2,
 *     "prompt": "...", "choices": ["...", "...", "...", "...", "..."],
 *     "correctIndex": 0, "explanation": "...",
 *     "memoryKeyword": "...",                        // 선택
 *     "sourceRefs": [{ "title": "...", "url": "https://..." }],
 *     "sourceAccessedAt": "2026-08-14",
 *     "rightsType": "self_created",
 *     "aiGenerationMeta": { "model": "...", "promptVersion": "v1",
 *                           "generatedAt": "2026-08-14T00:00:00.000Z" }  // 선택
 *   }
 * ]
 */

/**
 * 관리자 쓰기는 60 req/min 으로 제한된다 (공통 04 §3).
 * 대량 투입은 이 한도에 걸리므로 429/503 은 기다렸다 다시 보낸다.
 * 409/422 는 상태 문제라 재시도하지 않는다 (공통 05 §2).
 */
async function fetchWithRetry(url: string, init: RequestInit, attempt = 0): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status !== 429 && response.status !== 503) return response;
  if (attempt >= 5) return response;

  // 분 단위 창이라 넘게 기다린다.
  const waitMs = 5000 * (attempt + 1);
  console.log(`  … ${response.status} 응답, ${waitMs / 1000}초 후 재시도`);
  await new Promise((r) => setTimeout(r, waitMs));
  return await fetchWithRetry(url, init, attempt + 1);
}

/** 현재 revision 상태를 읽는다. 재실행 시 중복 전이를 피하기 위해 필요하다. */
async function readStatus(
  base: string,
  headers: Record<string, string>,
  questionId: string,
  revisionId: string,
): Promise<string> {
  const response = await fetch(`${base}/admin/v1/questions/${questionId}`, { headers });
  if (!response.ok) return 'draft';

  const body = (await response.json()) as {
    revisions?: { id: string; status: string }[];
  };
  return body.revisions?.find((r) => r.id === revisionId)?.status ?? 'draft';
}

/** 같은 문항을 두 번 넣지 않게 내용 기반 멱등 키를 만든다. */
function contentKey(item: unknown): string {
  const prompt = (item as { prompt?: string }).prompt ?? '';
  let hash = 0;
  for (let i = 0; i < prompt.length; i += 1) {
    hash = (hash * 31 + prompt.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

interface ImportResult {
  index: number;
  ok: boolean;
  questionId?: string;
  revisionId?: string;
  status?: string;
  error?: string;
}

function parseArgs(argv: string[]): { file: string; publish: boolean; base: string } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = argv.filter((a) => a.startsWith('--'));

  const file = positional[0];
  if (file == null) {
    throw new Error('사용법: import:questions -- <파일.json> [--publish] [--base=URL]');
  }

  const baseFlag = flags.find((f) => f.startsWith('--base='));
  return {
    file,
    publish: flags.includes('--publish'),
    base: baseFlag?.slice('--base='.length) ?? 'http://127.0.0.1:8080',
  };
}

/** 관리자 토큰을 발급한다. admin 역할 계정이 하나는 있어야 한다. */
async function getAdminToken(): Promise<string> {
  const [admin] = await db
    .select({ id: adminUsers.id, role: adminUsers.role })
    .from(adminUsers)
    .where(eq(adminUsers.role, 'admin'))
    .limit(1);

  if (admin == null) {
    throw new Error('admin 역할 계정이 없습니다. 먼저 관리자 계정을 만들어주세요.');
  }

  const issued = await issueAdminToken(admin.id, 'admin');
  return issued.token;
}

async function main(): Promise<void> {
  const { file, publish, base } = parseArgs(process.argv.slice(2));

  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('입력 파일은 JSON 배열이어야 합니다.');

  const token = await getAdminToken();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  console.log(`[import] ${raw.length}개 문항 · 대상 ${base} · publish=${publish}`);

  const results: ImportResult[] = [];

  for (const [index, item] of raw.entries()) {
    try {
      // 1) question + revision 1 을 한 번에 생성한다 (draft).
      //    서버가 한 트랜잭션으로 처리하므로 반쪽짜리 문항이 생기지 않는다.
      const created = await fetchWithRetry(`${base}/admin/v1/questions`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': `import-${index}-${contentKey(item)}` },
        body: JSON.stringify(item),
      });
      if (!created.ok) {
        const body = await created.text();
        throw new Error(`생성 실패 ${created.status} ${body.slice(0, 240)}`);
      }
      const { questionId, revisionId } = (await created.json()) as {
        questionId: string;
        revisionId: string;
      };

      // 멱등 재생으로 이미 올라간 문항일 수 있다. 현재 상태를 먼저 읽는다.
      let status = await readStatus(base, headers, questionId, revisionId);

      if (publish) {
        // 상태 머신을 순서대로 통과시킨다. 건너뛰면 서버가 막는다.
        // 이미 지난 단계는 건너뛴다. 재실행해도 안전해야 한다.
        const path = ['draft', 'review', 'approved', 'published'] as const;
        const from = Math.max(0, path.indexOf(status as (typeof path)[number]));

        for (const next of path.slice(from + 1)) {
          const patched = await fetchWithRetry(`${base}/admin/v1/revisions/${revisionId}/status`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ status: next }),
          });
          if (!patched.ok) {
            const body = await patched.text();
            throw new Error(`${next} 전이 실패 ${patched.status} ${body.slice(0, 200)}`);
          }
          status = next;
        }
      }

      results.push({ index, ok: true, questionId, revisionId, status });
    } catch (error) {
      results.push({
        index,
        ok: false,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log(`\n[import] 성공 ${ok.length} / 실패 ${failed.length}`);
  for (const f of failed) {
    console.error(`  #${f.index}: ${f.error}`);
  }

  if (publish && ok.length > 0) {
    const coverage = await fetch(`${base}/admin/v1/coverage`, { headers });
    if (coverage.ok) {
      console.log('\n[import] 시대별 커버리지');
      console.log(JSON.stringify(await coverage.json(), null, 2));
    }
  } else if (!publish) {
    console.log(
      '\n[import] draft 로만 넣었습니다. 검수 후 --publish 로 다시 실행하거나 CMS 에서 발행하세요.',
    );
  }

  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('[import] 실패');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$client.end();
  });
