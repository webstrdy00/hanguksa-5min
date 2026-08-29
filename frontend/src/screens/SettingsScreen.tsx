import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { trackScreen } from '../analytics/events.ts';
import { useCorrections, useExams } from '../api/hooks.ts';
import { DeleteAccountDialog } from '../components/DeleteAccountDialog.tsx';
import { NotificationSetting } from '../components/NotificationSetting.tsx';
import {
  ActionButton,
  AsyncBoundary,
  MIN_TOUCH_SIZE,
  Screen,
  SettingsScreenNotice,
  Section,
  StatusTag,
} from '../components/common.tsx';

/**
 * 설정 (02 UX §3).
 *
 * V1 항목: 목표 변경, 정정 안내, 비공식 고지, 문의.
 * 알림 동의는 9단계, 데이터 삭제는 10단계에서 붙인다.
 * 문서에 없는 메뉴는 만들지 않는다.
 */
export function SettingsScreen(): JSX.Element {
  const navigate = useNavigate();
  const exams = useExams(true);
  const corrections = useCorrections(true);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    trackScreen('settings');
  }, []);

  return (
    <Screen>
      <Section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
          <button
            type="button"
            onClick={() => void navigate(-1)}
            aria-label="뒤로 가기"
            style={{
              minWidth: MIN_TOUCH_SIZE,
              minHeight: MIN_TOUCH_SIZE,
              border: 'none',
              background: 'none',
              fontSize: 20,
              cursor: 'pointer',
            }}
          >
            ←
          </button>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>설정</h1>
        </div>
      </Section>

      <Section>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '24px 0 8px' }}>학습 목표</h2>
        <AsyncBoundary query={exams} loadingLabel="목표를 불러오고 있어요">
          {(data) => (
            <div
              style={{
                padding: 16,
                borderRadius: 12,
                border: '1px solid #e5e8eb',
              }}
            >
              {data.goal.exam == null ? (
                <p style={{ margin: 0, fontSize: 15, color: '#6b7684' }}>
                  아직 목표를 고르지 않았어요.
                </p>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
                    제{data.goal.exam.round}회 심화
                    {data.goal.targetGrade != null && ` · ${data.goal.targetGrade}급 목표`}
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: 14, color: '#6b7684' }}>
                    {data.goal.exam.examDate} · D-{data.goal.exam.dday}
                  </p>
                  {data.goal.needsReselection && (
                    <p style={{ marginTop: 8 }}>
                      <StatusTag tone="warning">다시 골라야 해요</StatusTag>
                    </p>
                  )}
                </>
              )}

              <div style={{ marginTop: 12 }}>
                <ActionButton variant="secondary" onClick={() => void navigate('/onboarding')}>
                  목표 변경하기
                </ActionButton>
              </div>
            </div>
          )}
        </AsyncBoundary>
      </Section>

      {corrections.data != null && corrections.data.corrections.length > 0 && (
        <Section>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: '24px 0 8px' }}>정정 안내</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {corrections.data.corrections.map((notice) => (
              <li
                key={notice.id}
                style={{
                  padding: 14,
                  marginBottom: 8,
                  borderRadius: 12,
                  background: '#f9fafb',
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: '#4e5968',
                }}
              >
                {notice.message}
                <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#8b95a1' }}>
                  {notice.publishedAt.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '24px 0 8px' }}>알림</h2>
        <NotificationSetting />
      </Section>

      <Section>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '24px 0 8px' }}>데이터 삭제</h2>
        <p
          style={{
            margin: '0 0 12px',
            color: '#6b7684',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          학습 기록과 오답노트, 연속 학습일이 모두 사라져요. 되돌릴 수 없어요.
        </p>
        <ActionButton variant="secondary" onClick={() => setDeleteOpen(true)}>
          데이터 삭제 및 탈퇴
        </ActionButton>
      </Section>

      <Section>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '24px 0 8px' }}>서비스 정보</h2>
        <SettingsScreenNotice />
      </Section>

      <div style={{ height: 32 }} />

      {deleteOpen && <DeleteAccountDialog onClose={() => setDeleteOpen(false)} />}
    </Screen>
  );
}
