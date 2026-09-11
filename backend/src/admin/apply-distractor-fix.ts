import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * 오답 선택지 교체 (04 §5 품질 기준).
 *
 *   pnpm --filter @hanguksa/backend questions:fix-distractor -- <문항.json> <교체맵.json>
 *
 * 정답을 더 줄일 수 없을 때는 반대로 오답을 정답 수준으로 늘린다.
 * 오답이 그럴듯해지면 길이 단서가 사라지고 문항 변별력도 함께 올라간다.
 *
 * 교체맵 형식: { "<문항 인덱스>": { "<선택지 인덱스>": "새 오답 문장" } }
 *
 * 안전장치:
 *  - 정답 위치를 교체 대상으로 지정하면 중단한다. 실수로 정답을 바꾸면 안 된다.
 *  - 교체 후 선택지가 중복되면 중단한다.
 *  - 교체 후에도 정답이 3자 이상 길면 경고한다.
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
    throw new Error('사용법: questions:fix-distractor -- <문항.json> <교체맵.json>');
  }

  const items = JSON.parse(readFileSync(target, 'utf8')) as Question[];
  const plan = JSON.parse(readFileSync(mapFile, 'utf8')) as Record<string, Record<string, string>>;

  let applied = 0;
  const stillLong: string[] = [];

  for (const [key, edits] of Object.entries(plan)) {
    const index = Number(key);
    const q = items[index];
    if (q == null) throw new Error(`인덱스 ${key} 가 범위를 벗어났습니다.`);

    for (const [slotKey, next] of Object.entries(edits)) {
      const slot = Number(slotKey);
      if (slot === q.correctIndex) {
        throw new Error(`#${key}: 정답 위치(${slot})는 이 도구로 바꿀 수 없습니다.`);
      }
      if (q.choices[slot] == null) throw new Error(`#${key}: 선택지 ${slot} 이 없습니다.`);
      q.choices[slot] = next;
      applied += 1;
    }

    if (new Set(q.choices).size !== q.choices.length) {
      throw new Error(`#${key}: 교체 후 선택지가 중복됩니다.`);
    }

    const answer = q.choices[q.correctIndex] ?? '';
    const longestOther = Math.max(
      ...q.choices.filter((_, i) => i !== q.correctIndex).map((c) => c.length),
      0,
    );
    const gap = answer.length - longestOther;
    if (gap >= 3) stillLong.push(`  #${index} 여전히 ${gap}자 김`);
  }

  writeFileSync(target, JSON.stringify(items, null, 2) + '\n', 'utf8');

  console.log(`[fix-distractor] ${applied}개 오답 교체 → ${target}`);
  if (stillLong.length > 0) {
    console.log(`[fix-distractor] 아직 남은 ${stillLong.length}건:`);
    for (const line of stillLong) console.log(line);
  }
}

main();
