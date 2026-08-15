/**
 * Drizzle 스키마 barrel.
 *
 * 모든 timestamp 는 timestamptz(UTC) 로 저장한다. 일자 경계(study_date)만 KST 달력 날짜(date)다.
 * (공통 02 §4, 09 §1)
 *
 * 상태값은 Postgres enum 대신 text + CHECK 로 구현한다. 이유는 enums.ts 주석 참고.
 * immutable 테이블(question_revisions, answers)에는 updated_at 을 두지 않고
 * 0001 migration 의 트리거가 내용 변경을 막는다.
 */
export * from './enums.ts';
export * from './admin.ts';
export * from './exams.ts';
export * from './identity.ts';
export * from './content.ts';
export * from './learning.ts';
export * from './ops.ts';
