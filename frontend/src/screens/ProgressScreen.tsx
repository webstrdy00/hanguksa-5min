import { useNavigate } from 'react-router-dom';
import { useProgress } from '../api/hooks.ts';
import { ERA_LABELS, type EraProgress } from '../api/types.ts';
import {
  AsyncBoundary,
  EmptyState,
  MIN_TOUCH_SIZE,
  Screen,
  Section,
  StatusTag,
} from '../components/common.tsx';

/**
 * 학습현황 (02 UX §3, 07 §3).
 *
 * 절대 하지 않는 것:
 * - 노출 5회 미만 영역에 퍼센트를 만들어 보여주기 (서버가 null 로 주고 화면은 "데이터 부족"으로 표시)
 * - 합격 확률/예상 점수 표시
 * - 내부 모델 점수 노출
 */
export function ProgressScreen(): JSX.Element {
  const navigate = useNavigate();
  const progress = useProgress(true);

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
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>학습현황</h1>
        </div>
      </Section>

      <AsyncBoundary
        query={progress}
        loadingLabel="학습 기록을 불러오고 있어요"
        empty={(data) =>
          data.summary.totalSeen === 0 ? (
            <EmptyState
              title="아직 학습 기록이 없어요"
              description="오늘 5문제를 풀면 시대별 기록이 쌓여요."
            />
          ) : null
        }
      >
        {(data) => (
          <>
            <Section>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 12,
                  marginTop: 20,
                }}
              >
                <SummaryCard label="연속 학습" value={`${data.streak.days}일`} />
                <SummaryCard
                  label="전체 정답률"
                  value={
                    data.summary.accuracyPercent == null
                      ? '데이터 부족'
                      : `${data.summary.accuracyPercent}%`
                  }
                />
              </div>
            </Section>

            <Section>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '28px 0 12px' }}>최근 7일</h2>
              <ul
                style={{
                  display: 'flex',
                  gap: 6,
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                }}
              >
                {data.recentDays.map((day) => (
                  <li key={day.studyDate} style={{ flex: 1, textAlign: 'center' }}>
                    <div
                      aria-hidden="true"
                      style={{
                        height: 44,
                        borderRadius: 10,
                        background: day.completed ? '#3182f6' : '#f2f4f6',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      {day.completed ? (day.score ?? 0) : ''}
                    </div>
                    <span style={{ fontSize: 11, color: '#8b95a1' }}>
                      {day.studyDate.slice(8)}일
                    </span>
                    <span className="sr-only">
                      {day.studyDate} {day.completed ? `완료, ${day.score ?? 0}점` : '학습 없음'}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '28px 0 12px' }}>시대별 기록</h2>
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 24px' }}>
                {data.eras.map((era) => (
                  <EraRow key={era.era} era={era} />
                ))}
              </ul>
            </Section>
          </>
        )}
      </AsyncBoundary>
    </Screen>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ padding: 16, borderRadius: 12, background: '#f9fafb' }}>
      <p style={{ color: '#6b7684', fontSize: 13, margin: 0 }}>{label}</p>
      <p style={{ margin: '4px 0 0', fontSize: 20, fontWeight: 700 }}>{value}</p>
    </div>
  );
}

function EraRow({ era }: { era: EraProgress }): JSX.Element {
  const label = ERA_LABELS[era.era] ?? era.era;
  const insufficient = era.status === 'insufficient_data';

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '14px 0',
        borderBottom: '1px solid #f2f4f6',
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 600 }}>{label}</span>

      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, color: '#8b95a1' }}>{era.seenCount}문항</span>
        {insufficient ? (
          // 07 §3: 표본이 적으면 퍼센트를 만들어 보여주지 않는다.
          <StatusTag tone="neutral">데이터 부족</StatusTag>
        ) : (
          <>
            <span style={{ fontSize: 15, fontWeight: 700 }}>{era.accuracyPercent}%</span>
            {era.status === 'weak' && <StatusTag tone="warning">복습 필요</StatusTag>}
          </>
        )}
      </span>
    </li>
  );
}
