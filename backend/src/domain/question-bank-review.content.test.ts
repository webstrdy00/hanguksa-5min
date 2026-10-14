import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ERAS } from '../db/schema/enums.ts';

// Private content suite: run explicitly with pnpm test:content.
// Editorial evidence is not human approval. Keep the exact reviewed payload so
// later content edits cannot silently inherit an earlier item's review receipt.
const questionSchema = z
  .object({
    era: z.enum(ERAS),
    prompt: z.string().min(5),
    choices: z.array(z.string().min(1)).length(5),
    correctIndex: z.number().int().min(0).max(4),
    sourceRefs: z.array(z.object({ title: z.string().min(1), url: z.string().url() })).min(1),
    wrongAnswerNotes: z.array(z.string().min(1).max(500)).length(4),
  })
  .passthrough();
const receiptSchema = z.object({
  baselineSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewKind: z.literal('ai-editorial-not-human-approval'),
  eras: z.array(z.enum(ERAS)).min(1),
  entries: z
    .array(
      z.object({
        index: z.number().int().positive(),
        originalPrompt: z.string().min(5),
        question: questionSchema,
        changes: z.array(z.string().min(1)).min(1),
        evidence: z.array(z.object({ url: z.string().url(), facts: z.string().min(1) })).min(1),
        answerRationale: z.string().min(1),
        abilityRationale: z.string().min(1),
        unresolved: z.array(z.string()),
      }),
    )
    .min(1),
});
const receiptFiles = [
  'full-review-ancient-20261011.json',
  'full-review-medieval-20261011.json',
  'full-review-early-modern-20261011.json',
  'full-review-modern-20261011.json',
];
const receipts = receiptFiles.map((file) =>
  receiptSchema.parse(
    JSON.parse(readFileSync(new URL(`../../../assets/outreach/${file}`, import.meta.url), 'utf8')),
  ),
);
const expansionReceiptSchema = receiptSchema.extend({
  batch: z.literal('expansion-450'),
  baselineSha256: z.literal('f24e5a313a786387f9e5f91eb9d29e5341a7daccf84d69083f0654c6e9fd9cd0'),
  entries: z
    .array(
      receiptSchema.shape.entries.element.extend({
        learningObjective: z.string().min(10),
        nonDuplicationRationale: z.string().min(10),
        nearestExistingIndices: z.array(z.number().int().min(1).max(310)),
        difficultyRationale: z.string().min(10),
      }),
    )
    .min(1),
});
const expansionReceipts = ['ancient', 'medieval', 'early-modern', 'modern'].map((era) =>
  expansionReceiptSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../assets/outreach/expansion-450-${era}-20261012.json`, import.meta.url),
        'utf8',
      ),
    ),
  ),
);
const bank: unknown[] = z
  .array(z.unknown())
  .parse(
    JSON.parse(readFileSync(new URL('../../../content/all-300.json', import.meta.url), 'utf8')),
  );
const entries = [...receipts, ...expansionReceipts].flatMap((receipt) => receipt.entries);

describe('full question-bank editorial evidence (not human approval)', () => {
  it('covers every current item exactly once without missing or overlapping era batches', () => {
    expect(new Set(receipts.map((receipt) => receipt.baselineSha256)).size).toBe(1);
    expect(receipts.flatMap((receipt) => receipt.eras).sort()).toEqual([...ERAS].sort());
    expect(expansionReceipts.flatMap((receipt) => receipt.eras).sort()).toEqual([...ERAS].sort());
    expect(entries.map((entry) => entry.index).sort((a, b) => a - b)).toEqual(
      bank.map((_question, index) => index + 1),
    );
    for (const receipt of [...receipts, ...expansionReceipts]) {
      for (const entry of receipt.entries) {
        expect(receipt.eras, `#${entry.index}`).toContain(entry.question.era);
      }
    }
  });

  it('preserves the approved 310 records exactly while adding 140 separately evidenced candidates', () => {
    expect(bank).toHaveLength(450);
    expect(
      createHash('sha256')
        .update(JSON.stringify(bank.slice(0, 310)))
        .digest('hex'),
    ).toBe('ddf2a74e67d17121d8500baa2959dbc93489bb1a2b979ca6d7cf8ec23a150ad1');
    const additions = expansionReceipts.flatMap((receipt) => receipt.entries);
    expect(additions).toHaveLength(140);
    expect(additions.map((entry) => entry.index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 140 }, (_, i) => i + 311),
    );
    const abilities = additions.reduce<Record<string, number>>((counts, { question }) => {
      const ability = z.string().parse(question['ability']);
      counts[ability] = (counts[ability] ?? 0) + 1;
      return counts;
    }, {});
    expect(abilities).toEqual({
      source_reading: 40,
      comparison: 35,
      causation: 30,
      chronology: 25,
      fact: 10,
    });
    for (const { question } of additions) {
      const answerLength = question.choices[question.correctIndex]!.length;
      const longestDistractor = Math.max(
        ...question.choices
          .filter((_, i) => i !== question.correctIndex)
          .map((choice) => choice.length),
      );
      expect(answerLength - longestDistractor, question.prompt).toBeLessThan(3);
    }
  });

  it('binds each receipt to the exact question and leaves no unresolved editorial issue', () => {
    for (const entry of entries) {
      expect(entry.question, `stale review #${entry.index}`).toEqual(bank[entry.index - 1]);
      expect(entry.unresolved, `unresolved review #${entry.index}`).toEqual([]);
    }
  });

  it('does not expose a repeating answer-position cycle in the added questions', () => {
    const positions = expansionReceipts
      .flatMap((receipt) => receipt.entries)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.question.correctIndex);
    for (let period = 1; period <= 10; period++) {
      expect(
        positions.slice(period).every((value, i) => value === positions[i]),
        `answer cycle of ${period}`,
      ).toBe(false);
    }
    for (let i = 3; i < positions.length; i++) {
      expect(new Set(positions.slice(i - 3, i + 1)).size).toBeGreaterThan(1);
    }
  });

  it('keeps chronology distractors plausible without changing the historical answer', () => {
    const question = questionSchema.parse(bank[328]);
    for (const choice of question.choices) {
      expect(choice.indexOf('(나)')).toBeLessThan(choice.indexOf('(라)'));
      expect(choice.indexOf('(다)')).toBeLessThan(choice.indexOf('(가)'));
    }
    expect(question.choices[question.correctIndex]).toBe('(나) → (라) → (다) → (가)');
  });

  it('does not attribute currency reorganization to the abolished mint', () => {
    const question = questionSchema.parse(bank[409]);
    const wrongChoice = question.choices.findIndex((choice) => choice.includes('백동화'));
    expect(wrongChoice).toBeGreaterThanOrEqual(0);
    expect(wrongChoice).not.toBe(question.correctIndex);
    const label = ['①', '②', '③', '④', '⑤'][wrongChoice];
    const note = question.wrongAnswerNotes.find((value) => value.startsWith(label!));
    expect(note).toContain('화폐 주조와 백동화 교환은 한성전기회사의 사업이 아닙니다');
    expect(note).not.toContain('전환국의 화폐 주조·정리');
  });

  it('records supporting facts for every source, not just an unexamined URL', () => {
    for (const entry of entries) {
      const refs = new Set(entry.question.sourceRefs.map((ref) => ref.url));
      const evidence = new Set(entry.evidence.map((item) => item.url));
      expect([...evidence].sort(), `source evidence #${entry.index}`).toEqual([...refs].sort());
      for (const url of refs) {
        expect(new URL(url).protocol, `#${entry.index}`).toBe('https:');
        expect(new URL(url).hostname, `#${entry.index}`).not.toMatch(/(^|\.)wikipedia\.org$/);
      }
    }
  });

  it('explains exactly the four wrong choices and does not label the answer as wrong', () => {
    const labels = ['①', '②', '③', '④', '⑤'];
    for (const entry of entries) {
      const { question } = entry;
      expect(question.wrongAnswerNotes.map((note) => note[0]).sort(), `#${entry.index}`).toEqual(
        labels.filter((_label, index) => index !== question.correctIndex).sort(),
      );
      expect(new Set(question.choices.map((choice) => choice.trim())).size, `#${entry.index}`).toBe(
        5,
      );
    }
  });
});
