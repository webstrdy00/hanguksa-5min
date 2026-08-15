import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertStudyDate,
  canCompleteSessionAt,
  daysUntilExam,
  differenceInDays,
  isStudyDate,
  isWithinGraceWindow,
  kstHour,
  startOfKstDay,
  toStudyDate,
} from './kst.ts';

/** StudyDate 는 브랜드 타입이므로 테스트에서도 검증을 거쳐 만든다. */
const d = assertStudyDate;

describe('toStudyDate', () => {
  it('UTC 자정이 아니라 KST 자정을 날짜 경계로 쓴다', () => {
    // 2026-08-14T14:59:59Z = KST 2026-08-14 23:59:59
    expect(toStudyDate(new Date('2026-08-14T14:59:59Z'))).toBe('2026-08-14');
    // 2026-08-14T15:00:00Z = KST 2026-08-15 00:00:00
    expect(toStudyDate(new Date('2026-08-14T15:00:00Z'))).toBe('2026-08-15');
  });

  it('UTC 기준으로는 날짜가 바뀌어도 KST 로는 같은 날일 수 있다', () => {
    expect(toStudyDate(new Date('2026-08-14T23:00:00Z'))).toBe('2026-08-15');
    expect(toStudyDate(new Date('2026-08-15T05:00:00Z'))).toBe('2026-08-15');
  });
});

describe('kstHour', () => {
  it('KST 시각을 0~23 으로 돌려준다', () => {
    expect(kstHour(new Date('2026-08-14T15:00:00Z'))).toBe(0);
    expect(kstHour(new Date('2026-08-14T15:59:59Z'))).toBe(0);
    expect(kstHour(new Date('2026-08-14T16:00:00Z'))).toBe(1);
    expect(kstHour(new Date('2026-08-14T14:00:00Z'))).toBe(23);
  });
});

describe('startOfKstDay', () => {
  it('KST 날짜의 00:00 에 해당하는 UTC 시각을 돌려준다', () => {
    expect(startOfKstDay(d('2026-08-15')).toISOString()).toBe('2026-08-14T15:00:00.000Z');
  });
});

describe('addDays / differenceInDays', () => {
  it('월 경계를 넘는다', () => {
    expect(addDays(d('2026-08-31'), 1)).toBe('2026-09-01');
    expect(addDays(d('2026-09-01'), -1)).toBe('2026-08-31');
  });

  it('연 경계를 넘는다', () => {
    expect(addDays(d('2026-12-31'), 1)).toBe('2027-01-01');
  });

  it('윤년 2월을 정확히 처리한다', () => {
    expect(addDays(d('2028-02-28'), 1)).toBe('2028-02-29');
    expect(addDays(d('2026-02-28'), 1)).toBe('2026-03-01');
  });

  it('두 날짜의 일수 차이를 계산한다', () => {
    expect(differenceInDays(d('2026-08-15'), d('2026-08-15'))).toBe(0);
    expect(differenceInDays(d('2026-08-15'), d('2026-10-17'))).toBe(63);
    expect(differenceInDays(d('2026-10-17'), d('2026-08-15'))).toBe(-63);
  });
});

describe('daysUntilExam', () => {
  it('시험일까지 남은 일수를 KST 기준으로 계산한다', () => {
    // 제80회 심화 시험일(문서 기준값). 실제 일정은 서버 exam_schedules 데이터를 쓴다.
    const now = new Date('2026-08-15T01:00:00Z'); // KST 2026-08-15 10:00
    expect(daysUntilExam(d('2026-10-17'), now)).toBe(63);
  });

  it('시험 당일은 0, 지난 시험은 음수를 돌려준다', () => {
    const examDay = new Date('2026-10-17T02:00:00Z'); // KST 2026-10-17 11:00
    expect(daysUntilExam(d('2026-10-17'), examDay)).toBe(0);

    const nextDay = new Date('2026-10-18T02:00:00Z');
    expect(daysUntilExam(d('2026-10-17'), nextDay)).toBe(-1);
  });
});

describe('canCompleteSessionAt (09 §1 유예창)', () => {
  const sessionDate = d('2026-08-14');

  it('같은 KST 날짜에는 완료할 수 있다', () => {
    // KST 2026-08-14 23:59
    expect(canCompleteSessionAt(sessionDate, new Date('2026-08-14T14:59:00Z'))).toBe(true);
  });

  it('다음 날 01:00 KST 직전까지는 전날 세션으로 완료할 수 있다', () => {
    // KST 2026-08-15 00:00
    expect(canCompleteSessionAt(sessionDate, new Date('2026-08-14T15:00:00Z'))).toBe(true);
    // KST 2026-08-15 00:59:59
    expect(canCompleteSessionAt(sessionDate, new Date('2026-08-14T15:59:59Z'))).toBe(true);
  });

  it('다음 날 01:00 KST 부터는 완료할 수 없다', () => {
    // KST 2026-08-15 01:00
    expect(canCompleteSessionAt(sessionDate, new Date('2026-08-14T16:00:00Z'))).toBe(false);
  });

  it('이틀 뒤에는 유예창 시간이어도 완료할 수 없다', () => {
    // KST 2026-08-16 00:30
    expect(canCompleteSessionAt(sessionDate, new Date('2026-08-15T15:30:00Z'))).toBe(false);
  });

  it('미래 날짜 세션은 완료 대상이 아니다', () => {
    expect(canCompleteSessionAt(d('2026-08-20'), new Date('2026-08-14T15:30:00Z'))).toBe(false);
  });
});

describe('isWithinGraceWindow', () => {
  it('KST 00:00~00:59 만 유예창이다', () => {
    expect(isWithinGraceWindow(new Date('2026-08-14T15:00:00Z'))).toBe(true);
    expect(isWithinGraceWindow(new Date('2026-08-14T15:59:59Z'))).toBe(true);
    expect(isWithinGraceWindow(new Date('2026-08-14T16:00:00Z'))).toBe(false);
    expect(isWithinGraceWindow(new Date('2026-08-14T14:00:00Z'))).toBe(false);
  });
});

describe('isStudyDate / assertStudyDate', () => {
  it('존재하지 않는 날짜를 거부한다', () => {
    expect(isStudyDate('2026-02-30')).toBe(false);
    expect(isStudyDate('2026-13-01')).toBe(false);
    expect(isStudyDate('2026-8-1')).toBe(false);
    expect(isStudyDate('20260801')).toBe(false);
  });

  it('올바른 날짜를 통과시킨다', () => {
    expect(isStudyDate('2026-08-15')).toBe(true);
    expect(isStudyDate('2028-02-29')).toBe(true);
    expect(assertStudyDate('2026-08-15')).toBe('2026-08-15');
  });

  it('잘못된 날짜에는 예외를 던진다', () => {
    expect(() => assertStudyDate('2026-02-30')).toThrow(RangeError);
  });
});
