/**
 * Asia/Seoul 일자 계산.
 *
 * 근거:
 * - 공통 02 §4: DB timestamp 는 UTC(timestamptz) 로 저장하고, 일자 경계 / 연속 출석 / daily set 배정만 KST 로 계산한다.
 * - 09 §1: study_date 는 서버 Asia/Seoul 기준으로 만든다.
 *          23:59 에 시작한 session 은 01:00 KST 까지 전날 session 으로 완료할 수 있고 streak 도 전날로 귀속한다.
 *
 * 날짜 문자열은 항상 'YYYY-MM-DD' 형식이며 KST 달력 날짜를 뜻한다.
 * KST 는 서머타임이 없으므로 UTC+9 고정으로 계산해도 안전하다.
 */

export const KST_TIME_ZONE = 'Asia/Seoul';

/** KST = UTC + 9시간 (서머타임 없음) */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 09 §1 유예창: 세션의 study_date 다음 날 01:00 KST 이전까지는 전날 세션으로 완료할 수 있다.
 */
export const GRACE_WINDOW_END_HOUR_KST = 1;

/**
 * 'YYYY-MM-DD' 형태의 KST 달력 날짜.
 *
 * 브랜드 타입이라 임의의 string 을 그대로 넣을 수 없다.
 * 외부(요청 body, DB row)에서 들어온 값은 반드시 assertStudyDate 로 검증한 뒤 사용한다.
 */
export type StudyDate = string & { readonly __brand: 'StudyDate' };

const STUDY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isStudyDate(value: string): value is StudyDate {
  if (!STUDY_DATE_PATTERN.test(value)) return false;
  const parsed = parseRawParts(value);
  if (parsed == null) return false;
  // 2026-02-30 같은 값을 걸러낸다.
  const normalized = formatKstDate(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)));
  return normalized === value;
}

export function assertStudyDate(value: string): StudyDate {
  if (!isStudyDate(value)) {
    throw new RangeError(`올바른 KST 날짜(YYYY-MM-DD)가 아닙니다: ${value}`);
  }
  return value;
}

function parseParts(value: StudyDate): { year: number; month: number; day: number } | null {
  return parseRawParts(value);
}

function parseRawParts(value: string): { year: number; month: number; day: number } | null {
  const segments = value.split('-');
  if (segments.length !== 3) return null;
  const [yearText, monthText, dayText] = segments as [string, string, string];
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return { year, month, day };
}

function formatKstDate(instant: Date): string {
  const shifted = new Date(instant.getTime() + KST_OFFSET_MS);
  const year = shifted.getUTCFullYear().toString().padStart(4, '0');
  const month = (shifted.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = shifted.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 특정 시각(UTC 기준 Date)이 KST 로 며칠인지 반환한다. */
export function toStudyDate(instant: Date): StudyDate {
  return formatKstDate(instant) as StudyDate;
}

/** 특정 시각의 KST 시(0~23). */
export function kstHour(instant: Date): number {
  const shifted = new Date(instant.getTime() + KST_OFFSET_MS);
  return shifted.getUTCHours();
}

/** KST 날짜의 00:00 에 해당하는 UTC 시각. */
export function startOfKstDay(date: StudyDate): Date {
  const parts = parseParts(assertStudyDate(date));
  if (parts == null) throw new RangeError(`올바른 KST 날짜가 아닙니다: ${date}`);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - KST_OFFSET_MS);
}

/** KST 날짜에 일수를 더한다. 음수도 허용한다. */
export function addDays(date: StudyDate, days: number): StudyDate {
  const parts = parseParts(assertStudyDate(date));
  if (parts == null) throw new RangeError(`올바른 KST 날짜가 아닙니다: ${date}`);
  const shifted = Date.UTC(parts.year, parts.month - 1, parts.day) + days * MS_PER_DAY;
  return formatKstDate(new Date(shifted - KST_OFFSET_MS)) as StudyDate;
}

/** from 에서 to 까지의 일수 차이. D-day 계산에 사용한다. */
export function differenceInDays(from: StudyDate, to: StudyDate): number {
  const fromParts = parseParts(assertStudyDate(from));
  const toParts = parseParts(assertStudyDate(to));
  if (fromParts == null || toParts == null) throw new RangeError('올바른 KST 날짜가 아닙니다.');
  const fromUtc = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);
  const toUtc = Date.UTC(toParts.year, toParts.month - 1, toParts.day);
  return Math.round((toUtc - fromUtc) / MS_PER_DAY);
}

/**
 * 시험일까지 남은 일수(D-day). 오늘이면 0, 지났으면 음수.
 * 시험 일정은 서버 exam_schedules 데이터만 사용한다 (09 §3).
 */
export function daysUntilExam(examDate: StudyDate, now: Date): number {
  return differenceInDays(toStudyDate(now), examDate);
}

/**
 * 09 §1: 세션은 자기 study_date 당일에 완료하는 것이 기본이고,
 * 다음 날 01:00 KST 이전까지는 전날 세션으로 완료할 수 있다.
 *
 * streak 는 완료 시각이 아니라 세션의 study_date 로 귀속한다.
 */
export function canCompleteSessionAt(sessionStudyDate: StudyDate, now: Date): boolean {
  const today = toStudyDate(now);
  if (today === sessionStudyDate) return true;

  const isNextDay = today === addDays(sessionStudyDate, 1);
  return isNextDay && kstHour(now) < GRACE_WINDOW_END_HOUR_KST;
}

/** 지금 시각이 전날 세션을 아직 완료할 수 있는 유예창(00:00~01:00 KST)인지. */
export function isWithinGraceWindow(now: Date): boolean {
  return kstHour(now) < GRACE_WINDOW_END_HOUR_KST;
}
