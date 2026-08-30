import { useState } from 'react';
import { ApiError, request, setAccessToken } from '../api/client.ts';
import { ActionButton, ErrorState, MIN_TOUCH_SIZE } from './common.tsx';

/**
 * 계정 삭제 확인 (공통 04 §5, 09 §6).
 *
 * - 되돌릴 수 없는 작업이라 확인 문구를 직접 입력받는다.
 * - "삭제됐다"고 화면에서만 알리지 않는다. 서버가 만든 job 상태를 보여준다.
 * - 삭제 후에는 토큰을 즉시 버려 이후 요청이 나가지 않게 한다.
 *
 * 다크패턴은 쓰지 않는다. 취소가 기본이고 삭제 버튼을 숨기거나 미루지 않는다 (02 UX §5).
 *
 * ⚠ 비게임 출시 가이드: `window.location.replace` 로 브라우저 히스토리를 조작하면
 * 검수에서 반려된다. 화면 이동은 라우터로만 처리한다.
 */

const CONFIRM_PHRASE = '삭제';

export function DeleteAccountDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** 삭제가 끝난 뒤 첫 화면으로 보낸다. */
  onDone: () => void;
}): JSX.Element {
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);

    try {
      const result = await request<{ jobId: string }>('/v1/account', {
        method: 'DELETE',
        body: { confirm: CONFIRM_PHRASE },
      });

      setJobId(result.jobId);
      // 삭제 요청이 접수되면 이 토큰은 더 이상 쓸 수 없다. 즉시 버린다.
      setAccessToken(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="계정 삭제"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'flex-end',
        zIndex: 100,
      }}
    >
      <div
        style={{
          width: '100%',
          background: '#fff',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: '20px 20px calc(env(safe-area-inset-bottom, 0px) + 20px)',
          maxHeight: '85dvh',
          overflowY: 'auto',
        }}
      >
        {jobId != null ? (
          <>
            <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>삭제 요청을 접수했어요</h2>
            <p style={{ color: '#4e5968', fontSize: 14, lineHeight: 1.6, margin: '0 0 16px' }}>
              학습 기록과 알림 설정은 순차적으로 지워져요.
              <br />
              백업에 남은 사본은 보관 주기가 끝나면 함께 사라져요.
            </p>
            <p
              style={{
                margin: '0 0 20px',
                padding: 12,
                borderRadius: 10,
                background: '#f9fafb',
                fontSize: 12,
                color: '#6b7684',
                wordBreak: 'break-all',
              }}
            >
              처리 번호 · {jobId}
            </p>
            <ActionButton onClick={onDone}>확인</ActionButton>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>정말 삭제할까요?</h2>
            <ul
              style={{
                margin: '0 0 16px',
                paddingLeft: 18,
                color: '#4e5968',
                fontSize: 14,
                lineHeight: 1.8,
              }}
            >
              <li>학습 기록, 오답노트, 연속 학습일이 모두 사라져요.</li>
              <li>알림 발송 대상에서도 제외돼요.</li>
              <li>되돌릴 수 없어요.</li>
            </ul>

            <label style={{ display: 'block', fontSize: 14, marginBottom: 16 }}>
              계속하려면 <strong>{CONFIRM_PHRASE}</strong> 를 입력해주세요
              <input
                type="text"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                style={{
                  width: '100%',
                  minHeight: MIN_TOUCH_SIZE,
                  marginTop: 6,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: '1px solid #d1d6db',
                  fontSize: 16,
                  boxSizing: 'border-box',
                }}
              />
            </label>

            {error != null && <ErrorState error={error} />}

            <div style={{ display: 'flex', gap: 8 }}>
              <ActionButton variant="secondary" onClick={onClose}>
                취소
              </ActionButton>
              <ActionButton
                onClick={() => void submit()}
                disabled={confirm !== CONFIRM_PHRASE}
                pending={pending}
                pendingLabel="처리하고 있어요"
              >
                삭제하기
              </ActionButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
