import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * 문항 정규화 (04 §5 품질 기준).
 *
 *   pnpm --filter @hanguksa/backend questions:normalize -- <파일...> [--write]
 *
 * 사람이 문항을 쓰면 정답 위치가 한쪽으로 쏠린다.
 * 쏠리면 사용자가 내용을 몰라도 위치로 찍어서 맞힐 수 있어 학습 도구로서 망가진다.
 *
 * 이 도구는 **선택지 순서만 바꿔** 정답 위치를 고르게 만든다.
 * 문항·해설·출처는 건드리지 않으므로 사실 관계가 변하지 않는다.
 *
 * 결정적으로 동작한다. 같은 입력이면 항상 같은 결과라 재실행해도 안전하다.
 */

interface Question {
  prompt: string;
  choices: string[];
  correctIndex: number;
  [key: string]: unknown;
}

/** 문항 내용으로 만든 안정적인 해시. 난수를 쓰면 재실행 결과가 달라진다. */
function stableHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/**
 * 정답 위치를 0~4 에 고르게 배분한다.
 *
 * 목표 위치는 "전체에서 몇 번째 문항인가"로 정해 균등하게 돌리고,
 * 같은 목표가 겹칠 때의 순서는 해시로 흔들어 규칙성이 보이지 않게 한다.
 */
export function rebalance(items: Question[]): { items: Question[]; moved: number } {
  const order = items
    .map((q, index) => ({ index, key: stableHash(q.prompt) }))
    .sort((a, b) => a.key - b.key || a.index - b.index);

  let moved = 0;
  const result = items.map((q) => ({ ...q, choices: [...q.choices] }));

  order.forEach((entry, rank) => {
    const target = rank % 5;
    const q = result[entry.index];
    if (q == null) return;
    if (q.correctIndex === target) return;

    // 정답과 목표 자리의 선택지를 맞바꾼다. 나머지 순서는 그대로 둔다.
    const answer = q.choices[q.correctIndex];
    const occupant = q.choices[target];
    if (answer == null || occupant == null) return;

    q.choices[target] = answer;
    q.choices[q.correctIndex] = occupant;
    q.correctIndex = target;
    moved += 1;
  });

  return { items: result, moved };
}

function distribution(items: Question[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const q of items) counts[q.correctIndex] = (counts[q.correctIndex] ?? 0) + 1;
  return counts;
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const write = args.includes('--write');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    throw new Error('사용법: questions:normalize -- <파일...> [--write]');
  }

  for (const file of files) {
    const items = JSON.parse(readFileSync(file, 'utf8')) as Question[];
    const before = distribution(items);
    const { items: fixed, moved } = rebalance(items);
    const after = distribution(fixed);

    console.log(`\n${file}  (${items.length}문항)`);
    console.log(`  이전 ${JSON.stringify(before)}`);
    console.log(`  이후 ${JSON.stringify(after)}  · ${moved}개 위치 조정`);

    if (write) {
      writeFileSync(file, JSON.stringify(fixed, null, 2) + '\n', 'utf8');
      console.log('  저장함');
    }
  }

  if (!write) console.log('\n--write 를 붙이면 파일에 반영합니다.');
}

main();
