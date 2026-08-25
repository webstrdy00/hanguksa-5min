import { useCallback, useEffect, useState } from 'react';
import { trackComplete } from '../analytics/events.ts';
import {
  canRequestAgreement,
  fetchConsent,
  requestNotificationAgreement,
  saveConsent,
  type ConsentState,
} from '../notifications/consent.ts';
import { ActionButton, ErrorState, StatusTag } from './common.tsx';

/**
 * 알림 설정 (공통 01 §4, 07 §7).
 *
 * - 사용자가 "켜기"를 누르는 명확한 행동이 있을 때만 동의 화면을 띄운다.
 * - 거절도 서버에 기록한다. 그래야 재요청 여부를 판단할 수 있다.
 * - 불안 자극 문구를 쓰지 않는다. "오늘 안 하면 떨어져요" 같은 표현 금지.
 * - 템플릿 코드가 없거나 지원되지 않는 환경이면 버튼을 숨기고 이유를 알린다.
 */
export function NotificationSetting(): JSX.Element {
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const available = canRequestAgreement();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setConsent(await fetchConsent());
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enable = async (): Promise<void> => {
    setPending(true);
    setError(null);

    try {
      const result = await requestNotificationAgreement();
      const saved = await saveConsent(result);
      setConsent(saved);

      if (result !== 'agreementRejected') {
        // 08 §6 보조 전환 지표
        trackComplete('notification_agreed');
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  const disable = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      setConsent(await saveConsent('agreementRejected'));
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  if (loading) {
    return (
      <p style={{ margin: 0, color: '#8b95a1', fontSize: 14 }} role="status">
        알림 설정을 불러오고 있어요
      </p>
    );
  }

  const agreed = consent?.functionalAgreed === true;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {agreed ? (
          <StatusTag tone="correct">켜짐</StatusTag>
        ) : (
          <StatusTag tone="neutral">꺼짐</StatusTag>
        )}
        <span style={{ fontSize: 14, color: '#4e5968' }}>
          오늘 학습을 아직 안 했을 때와 시험 D-day를 알려드려요.
        </span>
      </div>

      {error != null && <ErrorState error={error} onRetry={() => void load()} />}

      {!available ? (
        <p
          style={{
            margin: 0,
            padding: 14,
            borderRadius: 12,
            background: '#f9fafb',
            color: '#8b95a1',
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          지금 환경에서는 알림을 켤 수 없어요. 토스 앱에서 열면 설정할 수 있어요.
        </p>
      ) : agreed ? (
        <ActionButton
          variant="secondary"
          onClick={() => void disable()}
          pending={pending}
          pendingLabel="변경하고 있어요"
        >
          알림 끄기
        </ActionButton>
      ) : (
        <ActionButton
          onClick={() => void enable()}
          pending={pending}
          pendingLabel="동의 화면을 여는 중이에요"
        >
          알림 켜기
        </ActionButton>
      )}
    </div>
  );
}
