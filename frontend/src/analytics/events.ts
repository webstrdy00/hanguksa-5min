import { Analytics } from '@apps-in-toss/web-framework';

/**
 * Analytics 이벤트 계약 (공통 03 §1, 08 §6).
 *
 * 설치된 SDK 3.0.3 의 실제 시그니처:
 *   Analytics.log({ log_name, log_type, params })
 *   Analytics.screen/impression/click({ log_name, ...params })
 *
 * 이름 규칙 (공통 03 §1): screen_* / impression_* / click_* / complete_* / error_*
 *
 * 지표 설정 (공통 05 §5, 08 §6):
 *   활성 지표 = 7일 재방문
 *   대표 전환 = complete_daily_study
 *   보조 전환 = complete_review, notification_agreed
 *   운영     = question_report, voided_question_seen, schedule_changed
 *
 * ⚠️ 절대 넣지 않는 값 (07 §7, 공통 04 §4, 하드게이트 P0):
 *   - 문항 원문 / 선택지 / 사용자가 고른 답
 *   - anonKey 원문, 내부 access token
 *   - 사용자가 작성한 텍스트(오류 제보 보충 설명 등)
 *
 * SDK 가 anonymous_key 를 자동으로 붙이는 것은 플랫폼 동작이다.
 * 우리가 추가로 식별자를 실어 보내지 않는다.
 *
 * 샌드박스에서는 콘솔 출력만 되고 전송되지 않는다. 미지원 앱 버전에서는 조용히 무시된다.
 * 그래서 QR 테스트 성공을 이벤트 수집 성공으로 판정하면 안 된다 (공통 01 §8).
 */

/** 이벤트 속성은 원시값만 허용한다. 객체를 통째로 넘겨 원문이 새는 것을 막는다. */
type EventParams = Record<string, string | number | boolean>;

const isDev = import.meta.env.DEV;

function safeLog(operation: () => Promise<void> | undefined, name: string): void {
  try {
    const result = operation();
    // 분석 실패가 사용자 흐름을 막으면 안 된다.
    void Promise.resolve(result).catch((error: unknown) => {
      if (isDev) console.warn('[analytics] 전송 실패', name, error);
    });
  } catch (error) {
    if (isDev) console.warn('[analytics] 호출 실패', name, error);
  }
}

function toStringParams(params: EventParams): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
}

/** 화면 진입 (screen_*) */
export function trackScreen(screenName: string, params: EventParams = {}): void {
  safeLog(
    () => Analytics.screen({ log_name: `screen_${screenName}`, ...toStringParams(params) }),
    screenName,
  );
}

/** 클릭 (click_*) */
export function trackClick(actionName: string, params: EventParams = {}): void {
  safeLog(
    () => Analytics.click({ log_name: `click_${actionName}`, ...toStringParams(params) }),
    actionName,
  );
}

/** 노출 (impression_*) */
export function trackImpression(elementName: string, params: EventParams = {}): void {
  safeLog(
    () =>
      Analytics.impression({ log_name: `impression_${elementName}`, ...toStringParams(params) }),
    elementName,
  );
}

/** 완료 (complete_*) — 전환 지표로 콘솔에 등록하는 이벤트다. */
export function trackComplete(eventName: string, params: EventParams = {}): void {
  safeLog(
    () =>
      Analytics.log({
        log_name: `complete_${eventName}`,
        log_type: 'event',
        params: toStringParams(params),
      }),
    eventName,
  );
}

/** 운영 이벤트 — 콘텐츠 품질과 장애 추적용 */
export function trackOperational(eventName: string, params: EventParams = {}): void {
  safeLog(
    () =>
      Analytics.log({
        log_name: eventName,
        log_type: 'event',
        params: toStringParams(params),
      }),
    eventName,
  );
}

/** 오류 (error_*) — 오류 코드만 남긴다. 응답 본문이나 사용자 입력은 넣지 않는다. */
export function trackError(errorName: string, code: string): void {
  safeLog(
    () =>
      Analytics.log({
        log_name: `error_${errorName}`,
        log_type: 'error',
        params: { code },
      }),
    errorName,
  );
}

/**
 * 이 앱이 사용하는 이벤트 목록.
 * 콘솔에서 전환 지표를 설정할 때 이 이름을 그대로 쓴다.
 */
export const ANALYTICS_EVENTS = {
  /** 대표 전환 (08 §6) */
  conversion: 'complete_daily_study',
  /** 보조 전환 */
  secondary: ['complete_review', 'notification_agreed'],
  /** 운영 */
  operational: ['question_report', 'voided_question_seen', 'schedule_changed'],
} as const;
