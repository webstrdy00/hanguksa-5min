import { useState } from 'react';
import { useReportQuestion } from '../api/hooks.ts';
import { REPORT_REASONS, REPORT_REASON_LABELS, type ReportReason } from '../api/types.ts';
import { ActionButton, ErrorState, MIN_TOUCH_SIZE } from './common.tsx';

/**
 * 오류 제보 (06 백로그 P0, 08 §2).
 *
 * 사용자가 고른 답은 보내지 않는다. 서버도 저장하지 않는다 (08 §2).
 * 사유는 라디오로 고르고 보충 설명만 선택 입력이다.
 */
export function ReportDialog({
  questionRevisionId,
  onClose,
}: {
  questionRevisionId: string;
  onClose: () => void;
}): JSX.Element {
  const [reason, setReason] = useState<ReportReason>('wrong_answer');
  const [detail, setDetail] = useState('');
  const [done, setDone] = useState(false);
  const report = useReportQuestion();

  const submit = (): void => {
    report.mutate(
      {
        questionRevisionId,
        reason,
        ...(detail.trim().length > 0 ? { detail: detail.trim() } : {}),
      },
      { onSuccess: () => setDone(true) },
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="문항 오류 제보"
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
          maxHeight: '80dvh',
          overflowY: 'auto',
        }}
      >
        {done ? (
          <>
            <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>제보를 받았어요</h2>
            <p style={{ color: '#6b7684', fontSize: 14, margin: '0 0 20px' }}>
              검토 후 반영할게요. 이미 푼 기록과 연속 학습일은 그대로 유지돼요.
            </p>
            <ActionButton onClick={onClose}>닫기</ActionButton>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>어떤 문제가 있나요?</h2>
            <p style={{ color: '#6b7684', fontSize: 13, margin: '0 0 16px' }}>
              고른 답은 전송되지 않아요.
            </p>

            <fieldset style={{ border: 'none', padding: 0, margin: '0 0 16px' }}>
              <legend className="sr-only">제보 사유</legend>
              {REPORT_REASONS.map((value) => (
                <label
                  key={value}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    minHeight: MIN_TOUCH_SIZE,
                    fontSize: 15,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={value}
                    checked={reason === value}
                    onChange={() => setReason(value)}
                    style={{ width: 20, height: 20 }}
                  />
                  {REPORT_REASON_LABELS[value]}
                </label>
              ))}
            </fieldset>

            <label style={{ display: 'block', fontSize: 14, marginBottom: 6 }}>
              보충 설명 (선택)
              <textarea
                value={detail}
                onChange={(event) => setDetail(event.target.value.slice(0, 500))}
                rows={3}
                maxLength={500}
                placeholder="어떤 점이 이상한지 알려주세요"
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid #d1d6db',
                  fontSize: 15,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
            </label>

            {report.isError && <ErrorState error={report.error} />}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <ActionButton variant="secondary" onClick={onClose}>
                취소
              </ActionButton>
              <ActionButton
                onClick={submit}
                pending={report.isPending}
                pendingLabel="보내는 중이에요"
              >
                제보하기
              </ActionButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
