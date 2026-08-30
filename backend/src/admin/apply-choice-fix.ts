import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * 정답 선택지 교체 (04 §5 품질 기준).
 *
 *   pnpm --filter @hanguksa/backend questions:fix -- <문항.json> <교체맵.json>
 *
 * 정답이 오답보다 뚜렷하게 길면 내용을 몰라도 길이로 찍어서 맞힌다.
 * 이 도구는 손으로 다듬은 짧은 정답 문장을 일괄 반영한다.
 *
 * 교체맵 형식: { "<문항 인덱스>": "새 정답 문장" }
 *
 * 안전장치:
 *  - 인덱스가 범위를 벗어나면 중단한다.
 *  - 교체 후에도 오답보다 3자 이상 길면 경고한다. 조용히 넘어가지 않는다.
 *  - 정답 위치(correctIndex)는 건드리지 않는다. 위치 균형이 깨지지 않는다.
 */

interface Question {
  prompt: string;
  choices: string[];
  correctIndex: number;
  [key: string]: unknown;
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const [target, mapFile] = args;
  if (target == null || mapFile == null) {
    throw new Error('사용법: questions:fix -- <문항.json> <교체맵.json>');
  }

  const items = JSON.parse(readFileSync(target, 'utf8')) as Question[];
  const replacements = JSON.parse(readFileSync(mapFile, 'utf8')) as Record<string, string>;

  let applied = 0;
  const stillLong: string[] = [];

  for (const [key, next] of Object.entries(replacements)) {
    const index = Number(key);
    const q = items[index];
    if (q == null) throw new Error(`인덱스 ${key} 가 범위를 벗어났습니다.`);

    const before = q.choices[q.correctIndex];
    if (before == null) throw new Error(`인덱스 ${key} 의 정답을 찾을 수 없습니다.`);

    q.choices[q.correctIndex] = next;
    applied += 1;

    const longestOther = Math.max(
      ...q.choices.filter((_, i) => i !== q.correctIndex).map((c) => c.length),
      0,
    );
    const gap = next.length - longestOther;
    if (gap >= 3) stillLong.push(`  #${index} 여전히 ${gap}자 김 → ${next}`);
  }

  writeFileSync(target, JSON.stringify(items, null, 2) + '\n', 'utf8');

  console.log(`[fix] ${applied}건 반영 → ${target}`);
  if (stillLong.length > 0) {
    console.log(`[fix] 아직 남은 ${stillLong.length}건:`);
    for (const line of stillLong) console.log(line);
  }
}

main();
