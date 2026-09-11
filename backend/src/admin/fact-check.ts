import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * 출처 대조 사실 검증 (04 §3 ②③, 01 §8).
 *
 *   pnpm --filter @hanguksa/backend questions:factcheck -- <문항.json> [--cache=<디렉터리>]
 *
 * AI가 만든 문항의 가장 큰 위험은 사실 환각이다(01 §8 최상위 리스크).
 * 이 도구는 각 문항의 sourceRefs 원문을 받아, 정답과 해설의 **고유명사·연도**가
 * 실제로 그 출처에 나오는지 대조한다.
 *
 * ⚠ 이 검사는 "사실이다"를 증명하지 않는다.
 *    출처에 없는 주장을 골라내 사람이 볼 곳을 좁힐 뿐이다(04 §3 ③).
 *    통과했다고 발행해도 된다는 뜻이 아니다.
 */

interface Question {
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  memoryKeyword?: string;
  sourceRefs?: { title: string; url: string }[];
  [key: string]: unknown;
}

/*
 * 검증 대상은 **고유명사와 연도**만이다.
 *
 * 서술어("받아들이고", "세워", "폈다")는 문서마다 표현이 달라
 * 출처에 없는 게 당연하다. 이걸 세면 전부 오탐이 된다.
 * 사실 환각은 연도·인물·제도 이름에서 나므로 거기에만 집중한다.
 */
const PREDICATE_ENDINGS =
  /(다|고|서|며|으며|기|음|함|였|았|되|하|는|는다|습니다|입니다|했다|됐다|이다|한다|진다|난다|난|된|한|된다)$/;

function extractClaims(text: string): string[] {
  const years = [...text.matchAll(/\b(\d{3,4})년?\b/g)].map((m) => m[1]!);

  const words = text
    .replace(/[^가-홃0-9·]/g, ' ')
    .split(/\s+/)
    // 숫자가 섞인 제도명(6조, 12목, 22담로)과 2자 이상 명사만 남긴다.
    .filter((t) => t.length >= 2 && !PREDICATE_ENDINGS.test(t));

  return [...new Set([...years, ...words])];
}

/** 조사를 떼어 낸 어간 후보. "광종은" → "광종" */
function stems(token: string): string[] {
  const out = [token];
  for (const josa of ['은', '는', '이', '가', '을', '를', '의', '에', '과', '와', '으로', '로']) {
    if (token.endsWith(josa) && token.length - josa.length >= 2) {
      out.push(token.slice(0, token.length - josa.length));
    }
  }
  return out;
}

async function fetchSource(url: string, cacheDir: string): Promise<string> {
  const key = Buffer.from(url).toString('base64url').slice(0, 100) + '.txt';
  const file = path.join(cacheDir, key);
  if (existsSync(file)) return readFileSync(file, 'utf8');

  // 위키백과는 REST 요약 대신 전체 본문이 필요하다.
  const title = decodeURIComponent(url.split('/wiki/')[1] ?? '');
  const api = `https://ko.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${encodeURIComponent(title)}`;

  /*
   * 위키미디어 API 는 연속 호출을 막는다.
   * 식별 가능한 User-Agent 를 밝히고 간격을 둔다(공식 권장사항).
   * 429 가 나면 기다렸다 다시 보낸다.
   */
  let response: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(api, {
      signal: AbortSignal.timeout(20000),
      headers: {
        'user-agent':
          'hanguksa5min-content-check/1.0 (educational miniapp; contact via app store listing)',
        'accept-encoding': 'gzip',
      },
    });
    if (response.ok) break;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  if (response == null || !response.ok) throw new Error(`HTTP ${response?.status ?? 'none'}`);
  const body = (await response.json()) as {
    query?: { pages?: Record<string, { extract?: string }> };
  };
  const pages = body.query?.pages ?? {};
  const text = Object.values(pages)
    .map((p) => p.extract ?? '')
    .join('\n');

  writeFileSync(file, text, 'utf8');
  // 연속 조회 사이에 간격을 둔다. 대량 수집으로 보이면 차단된다.
  await new Promise((r) => setTimeout(r, 1200));
  return text;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const target = args.find((a) => !a.startsWith('--'));
  const cacheDir = (
    args.find((a) => a.startsWith('--cache='))?.split('=')[1] ?? '.factcache'
  ).trim();
  if (target == null) throw new Error('사용법: questions:factcheck -- <문항.json>');

  mkdirSync(cacheDir, { recursive: true });
  const items = JSON.parse(readFileSync(target, 'utf8')) as Question[];

  const report: { index: number; prompt: string; missing: string[]; source: string }[] = [];
  let fetched = 0;

  for (const [index, q] of items.entries()) {
    const ref = q.sourceRefs?.[0];
    if (ref == null) continue;

    let source = '';
    try {
      source = await fetchSource(ref.url, cacheDir);
      fetched += 1;
    } catch {
      report.push({
        index,
        prompt: q.prompt.slice(0, 30),
        missing: ['(출처 조회 실패)'],
        source: ref.url,
      });
      continue;
    }

    if (source.length < 200) {
      report.push({
        index,
        prompt: q.prompt.slice(0, 30),
        missing: ['(출처 본문 없음)'],
        source: ref.url,
      });
      continue;
    }

    // 정답과 해설에서 뽑은 핵심어가 출처에 하나도 없으면 근거 없는 주장이다.
    const answer = q.choices[q.correctIndex] ?? '';
    const claims = extractClaims(`${answer} ${q.explanation}`);
    const missing = claims.filter((c) => !stems(c).some((s) => source.includes(s)));

    /*
     * 연도가 출처에 없는 것은 가장 위험한 신호다. 환각된 날짜일 수 있다.
     * 고유명사는 표기 차이가 있어 여러 개가 같이 빠졌을 때만 의심한다.
     */
    const missingYears = missing.filter((m) => /^\d{3,4}$/.test(m));
    const missingNouns = missing.filter((m) => !/^\d{3,4}$/.test(m));

    const suspicious =
      missingYears.length > 0 || (claims.length >= 6 && missingNouns.length / claims.length > 0.7);

    if (suspicious) {
      report.push({
        index,
        prompt: q.prompt.slice(0, 30),
        missing: [...missingYears.map((y) => `⚠연도 ${y}`), ...missingNouns].slice(0, 8),
        source: ref.url,
      });
    }

    if (index % 25 === 0) console.log(`  ... ${index}/${items.length}`);
  }

  console.log(`\n[factcheck] ${items.length}문항 · 출처 조회 ${fetched}건`);
  console.log(`[factcheck] 사람 확인 필요: ${report.length}건\n`);
  for (const r of report) {
    console.log(`  #${r.index} ${r.prompt}`);
    console.log(`     출처에 없음: ${r.missing.join(', ')}`);
  }

  writeFileSync('factcheck-report.json', JSON.stringify(report, null, 2), 'utf8');
  console.log('\n상세: factcheck-report.json');
}

await main();
