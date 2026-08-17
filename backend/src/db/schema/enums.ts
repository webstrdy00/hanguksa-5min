/**
 * 상태/분류 값 집합.
 *
 * Postgres enum 타입 대신 `text + CHECK` 로 구현한다.
 * - enum 은 값 삭제가 불가능하고, ALTER TYPE ADD VALUE 로 추가한 값을 같은 트랜잭션에서 쓸 수 없다.
 *   migration 이 트랜잭션으로 실행되므로 expand -> migrate -> contract (공통 04 §6) 와 충돌한다.
 * - TypeScript 타입 안전성은 아래 상수 배열에서 그대로 얻는다.
 *
 * DB 에는 영문 코드를 저장하고 한국어 라벨은 화면에서 매핑한다.
 */

/** 04 §2 시대: 선사/고대/고려/조선전기/조선후기/개항기/일제강점/현대 */
export const ERAS = [
  'prehistoric', // 선사
  'ancient', // 고대
  'goryeo', // 고려
  'joseon_early', // 조선전기
  'joseon_late', // 조선후기
  'enlightenment', // 개항기
  'japanese_occupation', // 일제강점
  'modern', // 현대
] as const;
export type Era = (typeof ERAS)[number];

/** 04 §2 주제: 정치/경제/사회/문화/인물/유산 */
export const TOPICS = [
  'politics', // 정치
  'economy', // 경제
  'society', // 사회
  'culture', // 문화
  'figure', // 인물
  'heritage', // 유산
] as const;
export type Topic = (typeof TOPICS)[number];

/** 04 §2 능력: 사실/연대기/자료해석/비교/인과 */
export const ABILITIES = [
  'fact', // 사실
  'chronology', // 연대기
  'source_reading', // 자료해석
  'comparison', // 비교
  'causation', // 인과
] as const;
export type Ability = (typeof ABILITIES)[number];

/**
 * 문항 revision 상태.
 * 08 §1 이 요구하는 review/published/retired/voided 를 포함하고,
 * 04 §6 의 draft/approved 운영 단계를 더한다.
 * 04 §6 의 'scheduled' 는 예약 발행 기능이 V1 범위에 없어 제외했다.
 */
export const QUESTION_STATUSES = [
  'draft',
  'review',
  'approved',
  'published',
  'retired',
  'voided',
] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** 07 §5 권리 구분 */
export const RIGHTS_TYPES = [
  'self_created',
  'public_domain_verified',
  'licensed',
  'unknown',
] as const;
export type RightsType = (typeof RIGHTS_TYPES)[number];

/** 09 §3 시험 일정 상태 */
export const EXAM_STATUSES = ['scheduled', 'changed', 'cancelled', 'completed'] as const;
export type ExamStatus = (typeof EXAM_STATUSES)[number];

/** 03 §2 시험 종류. V1 학습 대상은 advanced 뿐이다 (07 §1). */
export const EXAM_TYPES = ['advanced', 'basic'] as const;
export type ExamType = (typeof EXAM_TYPES)[number];

/** 공통 02 §3 / 공통 06 §2 사용자 상태 */
export const IDENTITY_STATUSES = ['active', 'deleted', 'blocked'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/** 07 §2 세트 슬롯 출처: 복습 2 + 취약 1 + 신규 2 */
export const SLOT_SOURCES = ['review', 'weak', 'new'] as const;
export type SlotSource = (typeof SLOT_SOURCES)[number];

/** 08 §1 user_question_state.last_result */
export const ANSWER_RESULTS = ['correct', 'wrong'] as const;
export type AnswerResult = (typeof ANSWER_RESULTS)[number];

/** 오류 제보 사유 (문서 미정의 항목. 2026-08-15 확정) */
export const REPORT_REASONS = [
  'wrong_answer', // 정답이 틀림
  'ambiguous', // 복수 정답 해석 가능
  'typo', // 오타/표기 오류
  'outdated', // 최신 학설/기준과 불일치
  'rights', // 인용/자료 권리 문제
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ['open', 'triaged', 'resolved', 'rejected'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** 07 §9 정정 안내 유형 */
export const NOTICE_TYPES = ['correction', 'void'] as const;
export type NoticeType = (typeof NOTICE_TYPES)[number];

/** 공통 04 §5 삭제 작업 상태 */
export const DELETION_STATUSES = ['requested', 'in_progress', 'completed', 'failed'] as const;
export type DeletionStatus = (typeof DELETION_STATUSES)[number];

/** 관리자 역할. 인증 방식은 미정(AGENTS.md §9 #12)이며 여기서는 권한 구분만 둔다. */
export const ADMIN_ROLES = ['reviewer', 'editor', 'admin'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_STATUSES = ['active', 'disabled'] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];

/** 공통 04 §2 관리자 감사 대상 행위 */
export const AUDIT_ACTIONS = [
  'create_revision',
  'submit_question_review',
  'approve_question',
  'publish_question',
  'retire_question',
  'void_question',
  'update_exam_schedule',
  'resolve_report',
  'publish_correction',
  'toggle_feature_flag',
  'process_deletion',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 공통 01 §4 알림 발송 결과 */
export const SEND_STATUSES = ['sent', 'failed', 'skipped'] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];

export const PUSH_TARGET_STATUSES = ['unknown', 'active', 'revoked'] as const;
export type PushTargetStatus = (typeof PUSH_TARGET_STATUSES)[number];

export const IDEMPOTENCY_STATES = ['in_progress', 'completed'] as const;
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];

/** CHECK 제약에 넣을 SQL 리터럴 목록을 만든다. */
export function sqlValueList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}
