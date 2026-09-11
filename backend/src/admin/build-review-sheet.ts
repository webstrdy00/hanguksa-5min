import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * 문항 검수 시트 생성 (04 §3 파이프라인 ③ 지원).
 *
 *   pnpm --filter @hanguksa/backend review:sheet -- <파일.json> [출력.html]
 *
 * 300문항을 사람이 봐야 하는데 JSON 을 그대로 읽는 건 느리다.
 * 브라우저에서 바로 볼 수 있는 검수 시트를 만들어 검수 시간을 줄인다.
 *
 * 시트가 하는 일:
 *  - 정답을 눈에 띄게 표시해 정답 유일성을 빠르게 확인
 *  - 출처 링크를 걸어 사실 확인을 한 번의 클릭으로
 *  - 자동 점검에서 걸린 항목에 경고를 붙여 주의를 집중시킴
 *
 * 사람이 판정할 수 없는 것은 자동으로 통과시키지 않는다. 표시만 한다.
 */

interface Question {
  era: string;
  topic: string;
  ability: string;
  difficulty: number;
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  memoryKeyword?: string;
  sourceRefs?: { title: string; url: string }[];
  sourceAccessedAt?: string;
  rightsType?: string;
}

const ERA_LABEL: Record<string, string> = {
  prehistoric: '선사',
  ancient: '고대',
  goryeo: '고려',
  joseon_early: '조선전기',
  joseon_late: '조선후기',
  enlightenment: '개항기',
  japanese_occupation: '일제강점',
  modern: '현대',
};

/**
 * 자동 점검.
 * 여기서 걸리는 건 "확실한 문제"가 아니라 "사람이 더 봐야 할 곳"이다.
 */
/** 여러 문항에 똑같이 등장하는 정답 문장. 인덱스 어긋남 사고의 흔적이다. */
function collectDuplicatedAnswers(items: Question[]): Set<string> {
  const seen = new Map<string, number>();
  for (const q of items) {
    const a = q.choices[q.correctIndex] ?? '';
    seen.set(a, (seen.get(a) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([a]) => a));
}

function audit(q: Question, duplicatedAnswers: Set<string>): string[] {
  const warnings: string[] = [];

  if (new Set(q.choices).size !== q.choices.length) warnings.push('선택지 중복');
  if (q.choices.some((c) => c.length > 32)) warnings.push('긴 선택지(32자 초과) — 화면 확인 필요');

  /*
   * 정답이 가장 길면 내용을 몰라도 찍어서 맞힌다.
   * 평균 대비 비율로 보면 "고조선(3자) vs 부여(2자)" 같은 무해한 차이까지 걸린다.
   * 육안으로 "이게 제일 길다"가 보여야 악용되므로 최장 오답보다 3자 이상 긴 경우만 집는다.
   */
  const answer = q.choices[q.correctIndex] ?? '';
  const others = q.choices.filter((_, i) => i !== q.correctIndex);
  const longestOther = Math.max(...others.map((c) => c.length), 0);
  const gap = answer.length - longestOther;
  if (gap >= 3) {
    warnings.push(`정답이 최장 오답보다 ${gap}자 길음 — 길이로 추측 가능`);
  }

  /*
   * 정답이 문항·해설과 전혀 맞물리지 않으면 다른 문항의 문장이 잘못 들어온 것이다.
   * 일괄 치환 작업에서 인덱스가 어긋나면 실제로 이런 사고가 난다.
   * 검수자가 눈으로 찾기 전에 여기서 먼저 잡는다.
   */
  const tokens = answer
    .replace(/[^가-홃0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  // 해설은 정답을 반복하지 않도록 고쳐 둔 상태라 기억 키워드까지 함께 본다.
  const context = `${q.prompt} ${q.explanation} ${q.memoryKeyword ?? ''}`;
  /*
   * 해설을 "정답 반복 금지"로 고친 뒤라 어절이 안 겹치는 건 정상이다.
   * 그래서 단순 미중복은 잡지 않고, 정답이 **다른 문항의 정답과 거의 같을 때**만 집는다.
   * 인덱스 어긋남으로 문장이 통째로 복사되는 사고가 바로 이 모양이다.
   */
  const hits = tokens.filter((t) => context.includes(t)).length;
  if (tokens.length >= 3 && hits === 0 && duplicatedAnswers.has(answer)) {
    warnings.push('⚠ 정답이 다른 문항에도 똑같이 있음 — 섞였을 수 있음');
  }

  // 해설이 정답 문장을 그대로 반복하면 학습 가치가 낮다.
  if (q.explanation.includes(answer.slice(0, 12)) && answer.length > 12) {
    warnings.push('해설이 정답을 그대로 반복');
  }

  if ((q.sourceRefs?.length ?? 0) === 0) warnings.push('출처 없음 — publish 차단됨');
  if (q.sourceAccessedAt == null) warnings.push('출처 확인일 없음 — publish 차단됨');
  if (q.rightsType == null || q.rightsType === 'unknown')
    warnings.push('권리 표기 없음 — publish 차단됨');

  // 07 §7 금지 표현
  if (/합격 보장|반드시 나온다|무조건/.test(q.prompt + q.explanation)) {
    warnings.push('과장·보장 표현 의심');
  }

  return warnings;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(items: Question[]): string {
  const dupes = collectDuplicatedAnswers(items);
  const flagged = items.filter((q) => audit(q, dupes).length > 0).length;

  const cards = items
    .map((q, i) => {
      const warnings = audit(q, dupes);
      const choices = q.choices
        .map((c, ci) => {
          const isAnswer = ci === q.correctIndex;
          return `<li class="${isAnswer ? 'ans' : ''}">${escapeHtml(c)}${isAnswer ? ' <b>← 정답</b>' : ''}</li>`;
        })
        .join('');

      const sources = (q.sourceRefs ?? [])
        .map(
          (s) =>
            `<a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.title)}</a>`,
        )
        .join(' · ');

      return `<section class="card${warnings.length ? ' warn' : ''}">
  <div class="head">
    <span class="no">#${i + 1}</span>
    <span class="tag">${escapeHtml(ERA_LABEL[q.era] ?? q.era)}</span>
    <span class="tag">${escapeHtml(q.topic)}</span>
    <span class="tag">${escapeHtml(q.ability)}</span>
    <span class="tag">난이도 ${q.difficulty}</span>
  </div>
  ${warnings.length ? `<div class="warns">⚠ ${warnings.map(escapeHtml).join(' / ')}</div>` : ''}
  <p class="q">${escapeHtml(q.prompt)}</p>
  <ol class="choices">${choices}</ol>
  <p class="exp"><b>해설</b> ${escapeHtml(q.explanation)}</p>
  ${q.memoryKeyword ? `<p class="kw">기억 키워드 · ${escapeHtml(q.memoryKeyword)}</p>` : ''}
  <p class="src">출처 ${sources || '<i>없음</i>'} <span class="date">(확인 ${escapeHtml(q.sourceAccessedAt ?? '-')})</span></p>
  <label class="chk"><input type="checkbox"> 사실·정답 유일성·표현 확인함</label>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>문항 검수 시트 (${items.length}문항)</title>
<style>
  body{font-family:'Malgun Gothic',sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#191f28;background:#f7f8fa}
  h1{font-size:22px;margin:0 0 4px}
  .summary{background:#fff;border-radius:12px;padding:16px;margin-bottom:20px;font-size:14px;line-height:1.8}
  .summary b{color:#c23934}
  .card{background:#fff;border-radius:12px;padding:18px;margin-bottom:14px;border:1px solid #e5e8eb}
  .card.warn{border-color:#f0b429;background:#fffdf5}
  .head{display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
  .no{font-weight:800;font-size:15px;margin-right:4px}
  .tag{font-size:12px;background:#f2f4f6;border-radius:6px;padding:2px 8px;color:#4e5968}
  .warns{background:#fff3cd;color:#8a6100;font-size:13px;padding:8px 10px;border-radius:8px;margin-bottom:10px}
  .q{font-size:16px;font-weight:700;margin:0 0 10px;line-height:1.5}
  .choices{margin:0 0 12px;padding-left:22px}
  .choices li{font-size:14px;line-height:1.9;color:#4e5968}
  .choices li.ans{color:#1b64da;font-weight:700}
  .exp{font-size:14px;line-height:1.7;background:#f9fafb;padding:12px;border-radius:8px;margin:0 0 8px}
  .kw{font-size:13px;color:#6b7684;margin:0 0 8px}
  .src{font-size:13px;margin:0 0 10px}
  .src a{color:#3182f6}
  .date{color:#8b95a1}
  .chk{font-size:13px;color:#4e5968;display:block;border-top:1px solid #f2f4f6;padding-top:10px}
  @media print{.chk{display:none}body{background:#fff}}
</style></head><body>
<h1>문항 검수 시트</h1>
<div class="summary">
  전체 <b>${items.length}</b>문항 · 자동 점검 경고 <b>${flagged}</b>건<br>
  검수 기준 — ① 사실이 정확한가 ② 정답이 하나뿐인가 ③ 오답이 그럴듯한가 ④ 출처가 내용을 뒷받침하는가<br>
  <b>틀린 문항 번호를 적어서 알려주세요.</b> 수정 후 다시 투입합니다.
</div>
${cards}
</body></html>`;
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const input = args[0];
  if (input == null) throw new Error('사용법: review:sheet -- <파일.json> [출력.html]');
  const output = args[1] ?? input.replace(/\.json$/, '') + '-review.html';

  const items = JSON.parse(readFileSync(input, 'utf8')) as Question[];
  writeFileSync(output, render(items), 'utf8');

  const dupes = collectDuplicatedAnswers(items);
  const flagged = items.filter((q) => audit(q, dupes).length > 0);
  console.log(`[review] ${items.length}문항 → ${output}`);
  console.log(`[review] 자동 점검 경고 ${flagged.length}건`);
  for (const q of flagged) {
    console.log(
      `  #${items.indexOf(q) + 1} ${q.prompt.slice(0, 30)} → ${audit(q, dupes).join(' / ')}`,
    );
  }
}

main();
