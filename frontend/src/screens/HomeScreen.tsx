import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { trackClick, trackScreen } from '../analytics/events.ts';
import { useCorrections, useExams, useProgress } from '../api/hooks.ts';
import { ERA_LABELS } from '../api/types.ts';
import {
  ActionButton,
  AsyncBoundary,
  BottomCta,
  Screen,
  Section,
  StatusTag,
  UnofficialNotice,
} from '../components/common.tsx';

/**
 * 홈 (02 UX §3).
 *
 * "오늘 5문제" CTA 를 가장 크게 두고 통계는 아래로 내린다.
 * D-day 는 서버 exam_schedules 값만 쓴다. 앱에 날짜를 하드코딩하지 않는다 (09 §3).
 * 목표 회차가 만료되면 다음 목표 선택으로 전환한다 (08 §4).
 */
export function HomeScreen(): JSX.Element {
  const navigate = useNavigate();
  const exams = useExams(true);
  const progress = useProgress(true);
  const corrections = useCorrections(true);

  useEffect(() => {
    trackScreen('home');
  }, []);

  return (
    <Screen>
      <AsyncBoundary query={exams} loadingLabel="오늘 할 일을 불러오고 있어요">
        {(data) => {
          const goal = data.goal;
          const needsReselection = goal.needsReselection || goal.exam == null;

          return (
            <>
              <Section>
                <div style={{ paddingTop: 28 }}>
                  {needsReselection ? (
                    <>
                      <StatusTag tone="warning">목표 회차를 다시 골라주세요</StatusTag>
                      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '12px 0 4px' }}>
                        다음 시험을 선택해요
                      </h1>
                      <p style={{ color: '#6b7684', fontSize: 14, margin: 0 }}>
                        시험이 끝났거나 일정이 바뀌었어요.
                      </p>
                    </>
                  ) : (
                    <>
                      <p style={{ color: '#6b7684', fontSize: 14, margin: '0 0 4px' }}>
                        제{goal.exam?.round}회 심화 · {goal.exam?.examDate}
                      </p>
                      <h1 style={{ fontSize: 32, fontWeight: 800, margin: 0, lineHeight: 1.2 }}>
                        D-{goal.exam?.dday}
                      </h1>
                      {goal.targetGrade != null && (
                        <p style={{ color: '#6b7684', fontSize: 14, margin: '6px 0 0' }}>
                          목표 심화 {goal.targetGrade}급
                        </p>
                      )}
                    </>
                  )}
                </div>
              </Section>

              {needsReselection ? (
                <>
                  <div style={{ flex: 1 }} />
                  <BottomCta>
                    <ActionButton onClick={() => void navigate('/onboarding')}>
                      목표 다시 고르기
                    </ActionButton>
                  </BottomCta>
                </>
              ) : (
                <>
                  <Section>
                    <div
                      style={{
                        marginTop: 24,
                        padding: 20,
                        borderRadius: 16,
                        background: '#f0f6ff',
                      }}
                    >
                      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>
                        오늘의 5문제
                      </h2>
                      <p style={{ color: '#4e5968', fontSize: 14, margin: 0 }}>
                        틀린 시대는 자동으로 다시 나와요.
                      </p>
                    </div>
                  </Section>

                  <AsyncBoundary query={progress} loadingLabel="학습 기록을 불러오고 있어요">
                    {(stats) => (
                      <Section>
                        <dl
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: 12,
                            margin: '20px 0 0',
                          }}
                        >
                          <div style={{ padding: 16, borderRadius: 12, background: '#f9fafb' }}>
                            <dt style={{ color: '#6b7684', fontSize: 13 }}>연속 학습</dt>
                            <dd style={{ margin: '4px 0 0', fontSize: 20, fontWeight: 700 }}>
                              {stats.streak.days}일
                            </dd>
                          </div>
                          <div style={{ padding: 16, borderRadius: 12, background: '#f9fafb' }}>
                            <dt style={{ color: '#6b7684', fontSize: 13 }}>취약 시대</dt>
                            <dd style={{ margin: '4px 0 0', fontSize: 15, fontWeight: 600 }}>
                              {stats.summary.weakEras.length === 0
                                ? '아직 없어요'
                                : stats.summary.weakEras
                                    .slice(0, 2)
                                    .map((era) => ERA_LABELS[era] ?? era)
                                    .join(', ')}
                            </dd>
                          </div>
                        </dl>
                      </Section>
                    )}
                  </AsyncBoundary>

                  {corrections.data != null && corrections.data.corrections.length > 0 && (
                    <Section>
                      <div
                        style={{
                          marginTop: 20,
                          padding: 14,
                          borderRadius: 12,
                          background: '#fff8e1',
                        }}
                      >
                        <StatusTag tone="warning">정정 안내</StatusTag>
                        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#8a6100' }}>
                          {corrections.data.corrections[0]?.message}
                        </p>
                      </div>
                    </Section>
                  )}

                  <Section>
                    <nav style={{ display: 'flex', gap: 12, marginTop: 24 }}>
                      <HomeLink to="/wrong-notes" label="오답노트" />
                      <HomeLink to="/progress" label="학습현황" />
                      <HomeLink to="/settings" label="설정" />
                    </nav>
                  </Section>

                  <div style={{ flex: 1 }} />
                  <UnofficialNotice compact />
                  <BottomCta>
                    <ActionButton
                      onClick={() => {
                        trackClick('start_daily_study');
                        void navigate('/study');
                      }}
                    >
                      오늘 5문제 풀기
                    </ActionButton>
                  </BottomCta>
                </>
              )}
            </>
          );
        }}
      </AsyncBoundary>
    </Screen>
  );
}

function HomeLink({ to, label }: { to: string; label: string }): JSX.Element {
  return (
    <Link
      to={to}
      style={{
        flex: 1,
        minHeight: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
        border: '1px solid #e5e8eb',
        color: '#4e5968',
        fontSize: 14,
        fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      {label}
    </Link>
  );
}
