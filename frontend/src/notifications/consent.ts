import { Notification } from '@apps-in-toss/web-framework';
import { request } from '../api/client.ts';

/**
 * 알림 동의 (공통 01 §4, 공통 04 §1, 07 §7).
 *
 * 설치된 SDK 3.0.3 의 실제 시그니처를 확인하고 구현했다:
 *
 *   Notification.requestAgreement: ((params: {
 *     options: { templateCode: string };
 *     onEvent: (result: { type: 'newAgreement' | 'alreadyAgreed' | 'agreementRejected' }) => void;
 *     onError: (error: unknown) => void | Promise<void>;
 *   }) => () => void) & { isSupported: () => boolean }
 *
 * 주의할 점:
 * - Promise 가 아니라 **콜백**이고, 반환값은 **cleanup 함수**다. 반드시 해제해야 한다.
 * - templateCode 는 콘솔의 스마트발송 템플릿 코드다. 콘솔 등록 전에는 값이 없다.
 * - isSupported() 로 환경을 분기한다 (공통 01 §1).
 *
 * 07 §7 금지: 불안 자극("오늘 안 하면 떨어져요")이나 합격 보장 문구를 쓰지 않는다.
 * 템플릿 문구는 콘솔에서 작성하므로 등록 시 이 기준을 지켜야 한다.
 */

export type ConsentResult = 'newAgreement' | 'alreadyAgreed' | 'agreementRejected';

export interface ConsentState {
  functionalAgreed: boolean;
  functionalAgreedAt: string | null;
  marketingAgreed: boolean;
  marketingAgreedAt: string | null;
  pushTargetStatus: string;
}

/** 콘솔에 등록한 스마트발송 템플릿 코드. 미등록 상태면 비어 있다. */
const TEMPLATE_CODE = import.meta.env.VITE_NOTIFICATION_TEMPLATE_CODE ?? '';

/** 이 환경에서 알림 동의를 띄울 수 있는지. */
export function canRequestAgreement(): boolean {
  if (TEMPLATE_CODE.length === 0) return false;
  try {
    return Notification.requestAgreement.isSupported();
  } catch {
    // 로컬 브라우저에는 브릿지가 없다.
    return false;
  }
}

export async function fetchConsent(): Promise<ConsentState> {
  const result = await request<{ consent: ConsentState }>('/v1/notifications/consent');
  return result.consent;
}

/** SDK 결과를 서버에 기록한다. 거절도 기록해야 재요청 여부를 판단할 수 있다. */
export async function saveConsent(result: ConsentResult): Promise<ConsentState> {
  const saved = await request<{ consent: ConsentState }>('/v1/notifications/consent', {
    method: 'PUT',
    body: { result, channel: 'functional' },
  });
  return saved.consent;
}

/**
 * 알림 동의 화면을 띄우고 결과를 서버에 기록한다.
 *
 * 콜백 기반 API 를 Promise 로 감싸되, cleanup 을 반드시 호출한다.
 */
export function requestNotificationAgreement(): Promise<ConsentResult> {
  return new Promise<ConsentResult>((resolve, reject) => {
    if (!canRequestAgreement()) {
      reject(new Error('이 환경에서는 알림 동의를 요청할 수 없어요.'));
      return;
    }

    let cleanup: (() => void) | null = null;
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      // 콜백을 해제하지 않으면 다음 요청에서 중복 호출된다.
      cleanup?.();
      action();
    };

    cleanup = Notification.requestAgreement({
      options: { templateCode: TEMPLATE_CODE },
      onEvent: (event) => {
        finish(() => resolve(event.type));
      },
      onError: (error) => {
        finish(() => reject(error instanceof Error ? error : new Error('알림 동의에 실패했어요.')));
      },
    });
  });
}
