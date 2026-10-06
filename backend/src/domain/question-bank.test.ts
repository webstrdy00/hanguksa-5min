import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ABILITIES, ERAS, RIGHTS_TYPES, TOPICS } from '../db/schema/enums.ts';
import { evaluateCoverage } from './questions.ts';

// Source candidates only: these checks do not approve or publish revisions.
const raw: unknown = JSON.parse(
  readFileSync(new URL('../../../content/all-300.json', import.meta.url), 'utf8'),
);
const bank = z
  .array(
    z.object({
      era: z.enum(ERAS),
      topic: z.enum(TOPICS),
      ability: z.enum(ABILITIES),
      difficulty: z.number().int().min(1).max(3),
      prompt: z.string().min(5).max(2000),
      choices: z.array(z.string().min(1).max(500)).length(5),
      correctIndex: z.number().int().min(0).max(4),
      explanation: z.string().min(5).max(2000),
      sourceRefs: z.array(z.object({ title: z.string().min(1), url: z.string().url() })).min(1),
      sourceAccessedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      rightsType: z.enum(RIGHTS_TYPES),
      wrongAnswerNotes: z.array(z.string().min(1).max(500)).max(5).optional(),
    }),
  )
  .parse(raw);

const findQuestion = (phrase: string) => {
  const question = bank.find((item) => item.prompt.includes(phrase));
  if (!question) throw new Error(`Missing regression question: ${phrase}`);
  return question;
};

describe('source question bank integrity (not publication approval)', () => {
  it('keeps human approval out of generated source candidates', () => {
    const records = z.array(z.record(z.string(), z.unknown())).parse(raw);
    for (const record of records) {
      expect(record['reviewerId']).toBeUndefined();
      expect(record['reviewedAt']).toBeUndefined();
      expect(record['status']).toBeUndefined();
    }
  });

  it('retains era coverage and distinct prompts and options', () => {
    expect(
      evaluateCoverage(bank.map((q) => ({ era: q.era, topic: q.topic, count: 1 }))).gate.passed,
    ).toBe(true);
    expect(new Set(bank.map((q) => q.prompt.trim())).size).toBe(bank.length);
    for (const q of bank) {
      expect(new Set(q.choices.map((choice) => choice.trim())).size, q.prompt).toBe(5);
      expect(q.choices[q.correctIndex]?.trim().length, q.prompt).toBeGreaterThan(0);
      expect(q.rightsType, q.prompt).not.toBe('unknown');
      for (const ref of q.sourceRefs) expect(new URL(ref.url).protocol).toBe('https:');
    }
  });

  it('does not teach the misspelled dependent land grant or deny all coin circulation', () => {
    expect(bank.some((q) => /휴양전/.test(q.prompt + q.explanation + q.choices.join(' ')))).toBe(
      false,
    );
    expect(bank.some((q) => q.explanation.includes('휼양전'))).toBe(true);
    const q = findQuestion('고려 시대 화폐');
    expect(q.choices[q.correctIndex]).not.toContain('안 쓰였다');
    expect(q.choices[q.correctIndex]).toMatch(/널리|유통/);
  });

  it('distinguishes uprising origin from spread and the dates of separate inter-Korean agreements', () => {
    const uprising = findQuestion('임술');
    expect(uprising.explanation).toContain('단성');
    expect(uprising.choices[uprising.correctIndex]).not.toContain('진주에서 시작');
    const declaration = findQuestion('6·15');
    // The revised choices compare agreements, not the removed tourism claim.
    expect(declaration.choices[declaration.correctIndex]).not.toMatch(/금강산.*시작/);
    expect(declaration.explanation).toContain('2000');
    expect(declaration.explanation).toMatch(/기본 합의서.*1991/);
    expect(declaration.explanation).toMatch(/7·4.*1972/);
  });

  it('does not reuse two Yuan-interference distractors for faction formation', () => {
    const q = findQuestion('붕당이 형성');
    expect(q.choices.filter((choice) => /원의 간섭/.test(choice)).length).toBeLessThan(2);
  });

  it('explains direct reporting to Taejong without reversing the role of Uijeongbu', () => {
    const q = findQuestion('태종이 왕권을 강화');
    expect(q.explanation).toContain('의정부를 거치지 않고 국왕에게 직접 보고');
    expect(q.explanation).not.toContain('의정부를 거들고');
    expect(q.sourceRefs.map((ref) => ref.url)).toContain(
      'https://encykorea.aks.ac.kr/Article/E0059039',
    );
  });

  it('keeps the Six Licensed Stores exception in Jeongjo policy explanations', () => {
    const q = findQuestion('정조가 시행한 정책');
    expect(q.explanation).toContain('육의전을 제외한');
    expect(q.explanation).toContain('금난전권을 폐지');
    expect(q.sourceRefs.map((ref) => ref.url)).toContain(
      'https://encykorea.aks.ac.kr/Article/E0033551',
    );
  });

  it('identifies Sasimgwan appointees rather than treating all local magnates as appointees', () => {
    const q = findQuestion('태조 왕건이 실시한 정책');
    expect(q.explanation).toContain('지방에 연고가 있는 고관·공신');
    expect(q.explanation).not.toContain('지방 호족을 그 지역의 사심관으로 임명');
    expect(q.sourceRefs.map((ref) => ref.url)).toContain(
      'https://encykorea.aks.ac.kr/Article/E0025783',
    );
  });

  it('does not present a painter and his pen name as two different painters', () => {
    const question = bank.find(
      (q) =>
        q.prompt.includes('풍속화') &&
        q.choices[q.correctIndex]?.includes('김홍도') &&
        q.choices[q.correctIndex]?.includes('신윤복'),
    );
    expect(question).toBeDefined();
    for (const choice of question!.choices) {
      expect(choice).not.toMatch(/장승업\s*(과|와|·|,)\s*오원|오원\s*(과|와|·|,)\s*장승업/);
    }
  });

  it('tests Seookje residence rather than leaking the answer through its name', () => {
    const q = findQuestion('서옥제의 혼인 후');
    expect(q.choices.every((choice) => !choice.includes('서옥제'))).toBe(true);
    expect(q.choices[q.correctIndex]).toMatch(/처가.*기간.*남편/);
    const longestDistractor = Math.max(
      ...q.choices
        .filter((_choice, index) => index !== q.correctIndex)
        .map((choice) => choice.length),
    );
    expect(q.choices[q.correctIndex]!.length).toBeLessThanOrEqual(longestDistractor + 3);
  });

  it('separates Buddhist state recognition from earlier transmission', () => {
    const q = findQuestion('삼국이 불교');
    expect(q.prompt).toMatch(/국가.*공인/);
    expect(q.choices[q.correctIndex]).toContain('고구려 → 백제 → 신라');
    expect(q.explanation).toContain('민간 전래');
  });

  it('does not reject Goryeo education merely because the term Taehak occurs', () => {
    const q = findQuestion('고려의 관학과 사학');
    expect(q.choices[q.correctIndex]).toMatch(/국자감.*사학/);
    expect(q.choices).not.toContain('태학을 세워 유학을 가르쳤다');
    expect(q.explanation).toMatch(/국자감.*태학/);
  });

  it('qualifies neighboring-household collection as military cloth rather than any tax', () => {
    const q = findQuestion('환곡의 문란');
    const neighborChoice = q.choices.find((choice) => choice.includes('이웃'));
    expect(neighborChoice).toContain('군포');
    expect(q.explanation).toMatch(/인징.*환곡/);
  });

  it('distinguishes founding-era Donghak from later Innaecheon formulation', () => {
    const q = findQuestion('동학을 창도할 당시');
    expect(q.choices[q.correctIndex]).toContain('시천주');
    expect(q.choices[q.correctIndex]).not.toContain('인내천');
    expect(q.explanation).toContain('손병희');
    expect(q.explanation).toContain('1905');
  });

  it('bounds reform and foreign-relations questions to the intended phase', () => {
    const reform = findQuestion('제1차 갑오개혁으로');
    expect(reform.prompt).toContain('1894년');
    expect(reform.choices[reform.correctIndex]).not.toContain('단발령');
    expect(reform.explanation).toMatch(/단발령.*을미개혁/);
    const relations = findQuestion('개항 이전까지 조선과 일본');
    expect(relations.prompt).toContain('1876년');
    expect(relations.choices[relations.correctIndex]).toContain('통신사');
  });

  it('separates Gando violence from the 1931 invasion and preserves chronology', () => {
    const q = findQuestion('간도 참변');
    const invasion = q.choices.find((choice) => choice.includes('만주를 침략'));
    expect(invasion).toContain('1931년');
    expect(q.explanation).toMatch(/청산리 전투 이전.*학살/);
  });

  it('does not treat later direct-election changes as immediate May 16 outcomes', () => {
    const q = findQuestion('5·16 군사 정변 직후');
    expect(q.prompt).toContain('1961년');
    expect(q.choices[q.correctIndex]).toContain('국가 재건 최고 회의');
    expect(q.explanation).toContain('1962년');
  });

  it('bounds historical generalizations to the intended institution and period', () => {
    const land = findQuestion('고려 전시과');
    expect(
      land.choices.filter((_choice, index) => index !== land.correctIndex).join(' '),
    ).not.toContain('현직 관리에게만');
    const exams = findQuestion('조선의 과거');
    expect(exams.explanation).toContain('서얼');
    expect(exams.explanation).toContain('문과');
    const democracy = bank.find((q) => q.choices[q.correctIndex]?.includes('지방 자치제가 부활'));
    expect(democracy?.prompt).toContain('1987년');
  });

  it('provides sourced, distinct additions and labels newly written explanatory clues', () => {
    for (const name of ['강수', '이색', '홍대용', '승정원', '대한광복회', '제주4·3사건']) {
      const q = bank.find((item) => item.choices[item.correctIndex] === name);
      expect(q, name).toBeDefined();
      expect(q?.prompt, name).toContain('학습용 설명:');
      expect(q?.prompt, name).not.toContain(name);
      expect(
        q?.sourceRefs.some((ref) => new URL(ref.url).hostname === 'encykorea.aks.ac.kr'),
        name,
      ).toBe(true);
      expect(q?.wrongAnswerNotes?.length, name).toBeGreaterThan(0);
    }
  });
});
