import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function generateSheet(extra: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), 'question-review-'));
  try {
    const input = join(directory, 'questions.json');
    const output = join(directory, 'review.html');
    writeFileSync(
      input,
      JSON.stringify([
        {
          era: 'goryeo',
          topic: 'politics',
          ability: 'comparison',
          difficulty: 2,
          prompt: '검수 도구 테스트용 문항입니다.',
          choices: ['선택 하나', '선택 둘', '선택 셋', '선택 넷', '선택 다섯'],
          correctIndex: 1,
          explanation: '검수 도구 테스트용 해설입니다.',
          sourceRefs: [{ title: '테스트 출처', url: 'https://example.com/source' }],
          sourceAccessedAt: '2026-10-11',
          rightsType: 'self_created',
          ...extra,
        },
      ]),
      'utf8',
    );
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./build-review-sheet.ts', import.meta.url)), input, output],
      { encoding: 'utf8' },
    );
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('question review sheet CLI', () => {
  it('shows every distractor rationale and provenance as escaped text without approving it', () => {
    const html = generateSheet({
      wrongAnswerNotes: ['① 시대가 다릅니다.', '③ <script>alert(1)</script> & 근거'],
      rightsNote: '자체 작성 <요약>이며 "원문 인용"이 아닙니다.',
    });
    expect(html).toContain('오답 구분 근거');
    expect(html).toContain('<li>① 시대가 다릅니다.</li>');
    expect(html).toContain('<li>③ &lt;script&gt;alert(1)&lt;/script&gt; &amp; 근거</li>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('자체 작성 &lt;요약&gt;이며 &quot;원문 인용&quot;이 아닙니다.');
    expect(html).toContain('사람의 검수 완료나 운영 발행을 의미하지 않습니다.');
    expect(html).not.toMatch(/<input[^>]*\bchecked\b/);
  });

  it.each([{}, { wrongAnswerNotes: [], rightsNote: '' }])(
    'does not produce empty editorial sections when notes are absent: %j',
    (extra) => {
      const html = generateSheet(extra);
      expect(html).not.toContain('오답 구분 근거');
      expect(html).not.toContain('권리 메모');
      expect(html).toContain('검수 도구 테스트용 해설입니다.');
    },
  );
});
