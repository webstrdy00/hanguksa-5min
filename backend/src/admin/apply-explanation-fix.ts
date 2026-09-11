import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * 해설 교체 (04 §5 품질 기준).
 *
 *   pnpm --filter @hanguksa/backend questions:fix-explanation -- <문항.json> <교체맵.json>
 *
 * 해설이 정답 문장을 그대로 되뇌면 학습 가치가 없다.
 * 왜 그것이 정답인지, 나머지가 왜 오답인지를 알려 주어야 한다.
 *
 * 교체맵 형식: { "<문항 인덱스>": "새 해설" }
 *
 * 안전장치:
 *  - 교체 후에도 정답 문장을 그대로 담고 있으면 경고한다.
 *  - 해설이 너무 짧으면(20자 미만) 중단한다. 빈 껍데기 해설을 막는다.
 *  - 선택지와 정답 위치는 건드리지 않는다.
 */

interface Question {
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  [key: string]: unknown;
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const [target, mapFile] = args;
  if (target == null || mapFile == null) {
    throw new Error('사용법: questions:fix-explanation -- <문항.json> <교체맵.json>');
  }

  const items = JSON.parse(readFileSync(target, 'utf8')) as Question[];
  const replacements = JSON.parse(readFileSync(mapFile, 'utf8')) as Record<string, string>;

  let applied = 0;
  const stillRepeating: string[] = [];

  for (const [key, next] of Object.entries(replacements)) {
    const index = Number(key);
    const q = items[index];
    if (q == null) throw new Error(`인덱스 ${key} 가 범위를 벗어났습니다.`);
    if (next.length < 20) throw new Error(`#${key}: 해설이 너무 짧습니다(${next.length}자).`);

    q.explanation = next;
    applied += 1;

    const answer = q.choices[q.correctIndex] ?? '';
    if (answer.length > 12 && next.includes(answer.slice(0, 12))) {
      stillRepeating.push(`  #${index} 여전히 정답을 반복함`);
    }
  }

  writeFileSync(target, JSON.stringify(items, null, 2) + '\n', 'utf8');

  console.log(`[fix-explanation] ${applied}건 반영 → ${target}`);
  if (stillRepeating.length > 0) {
    console.log(`[fix-explanation] 아직 남은 ${stillRepeating.length}건:`);
    for (const line of stillRepeating) console.log(line);
  }
}

main();
