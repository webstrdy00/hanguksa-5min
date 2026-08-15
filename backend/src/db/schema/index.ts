/**
 * Drizzle 스키마 barrel.
 *
 * 0단계에서는 비즈니스 테이블을 만들지 않는다.
 * 1단계에서 users / identity 부터 추가하고, 이후 08 §1 의 DB 제약을 그대로 옮긴다.
 *   - question_revisions: revision immutable
 *   - study_sessions: UNIQUE(user_id, study_date KST)
 *   - answers: UNIQUE(session_id, question_revision_id), 제출 후 수정 금지
 *   - user_question_state: UNIQUE(user_id, canonical_question_id)
 *   - exam_schedules: 회차 UNIQUE + 변경 로그 보존
 *
 * 모든 timestamp 는 timestamptz(UTC) 로 저장한다 (공통 02 §4).
 */
export {};
