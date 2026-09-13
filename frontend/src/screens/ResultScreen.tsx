import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCompleteSession, useTodaySession } from '../api/hooks.ts';
import { trackComplete, trackScreen } from '../analytics/events.ts';
import { ERA_LABELS } from '../api/types.ts';
import {
  ActionButton,
  AsyncBoundary,
  BottomCta,
  ErrorState,
  LoadingState,
  Screen,
  Section,
  StatusTag,
} from '../components/common.tsx';

/**
 * 오늘 결과 (02 UX §3).
 *
 * "합격 가능성 83%" 같은 근거 없는 숫자를 쓰지 않는다 (02 UX, 07 §3).
 * 대신 "오늘 4/5, 어느 시대 복습 필요"처럼 행동 가능한 피드백만 준다.
 *
 * 완료 처리는 화면 진입 시 한 번만 호출한다. 재요청해도 서버가 같은 결과를 주지만
 * 클라이언트도 중복 호출을 만들지 않는다 (02 UX §5).
 */
export function ResultScreen(): JSX.Element {
  const navigate = useNavigate();
  const session = useTodaySession(true);
  const sessionId = session.data?.session.id;
  const complete = useCompleteSession(sessionId);
  const requested = useRef(false);

  useEffect(() => {
    trackScreen('result');
  }, []);

  const alreadyCompleted = session.data?.session.completedAt != null;

  useEffect(() => {
    if (sessionId == null || requested.current || alreadyCompleted) return;
    requested.current = true;
    complete.mutate(undefined, {
      onSuccess: (data) => {
        // 대표 전환 지표 (08 §6). 점수와 연속일수만 남기고 문항 정보는 넣지 않는다.
        trackComplete('daily_study', {
          score: data.session.score,
          valid_count: data.validCount,
          streak_days: data.streak.days,
        });
      },
    });
  }, [sessionId, alreadyCompleted, complete]);

  return (
    <Screen>
      <AsyncBoundary query={session} loadingLabel="결과를 정리하고 있어요">
        {(data) => {
          const answered = data.items.filter((item) => !item.voided && item.answered);
          const wrongItems = answered.filter((item) => item.isCorrect === false);
          const voidedCount = data.items.filter((item) => item.voided).length;

          const score = complete.data?.session.score ?? data.session.score;
          const validCount = complete.data?.validCount ?? answered.length;
          const streakDays = complete.data?.streak.days;

          if (complete.isPending && score == null) {
            return <LoadingState label="오늘 학습을 마무리하고 있어요" />;
          }

          if (complete.isError && score == null) {
            return (
              <ErrorState
                error={complete.error}
                onRetry={() => {
                  requested.current = false;
                  complete.reset();
                  session.refetch();
                }}
              />
            );
          }

          const wrongEras = [...new Set(wrongItems.map((item) => item.era))];

          return (
            <>
              <Section>
                <div style={{ paddingTop: 40, textAlign: 'center' }}>
                  <p style={{ color: '#6b7684', fontSize: 15, margin: '0 0 8px' }}>오늘의 결과</p>
                  <p style={{ fontSize: 40, fontWeight: 800, margin: 0, lineHeight: 1.1 }}>
                    {score ?? 0}
                    <span style={{ fontSize: 22, color: '#8b95a1' }}> / {validCount}</span>
                  </p>
                  {streakDays != null && (
                    <p style={{ marginTop: 12 }}>
                      <StatusTag tone="correct">연속 학습 {streakDays}일째</StatusTag>
                    </p>
                  )}
                </div>
              </Section>

              {voidedCount > 0 && (
                <Section>
                  <div
                    style={{
                      marginTop: 24,
                      padding: 14,
                      borderRadius: 12,
                      background: '#fff8e1',
                      color: '#8a6100',
                      fontSize: 14,
                      lineHeight: 1.5,
                    }}
                  >
                    오류가 확인된 문항 {voidedCount}개를 채점에서 제외했어요. 학습 완료와 연속
                    학습일은 그대로예요.
                  </div>
                </Section>
              )}

              <Section>
                <div
                  style={{
                    marginTop: 24,
                    padding: 18,
                    borderRadius: 14,
                    background: '#f9fafb',
                  }}
                >
                  <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 10px' }}>
                    내일은 이렇게 준비해요
                  </h2>
                  {wrongEras.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 15, color: '#4e5968' }}>
                      오늘은 모두 맞혔어요. 내일은 새로운 문제로 이어갈게요.
                    </p>
                  ) : (
                    <p style={{ margin: 0, fontSize: 15, color: '#4e5968', lineHeight: 1.6 }}>
                      {wrongEras.map((era) => ERA_LABELS[era] ?? era).join(', ')} 문항{' '}
                      {wrongItems.length}개를 틀렸어요. 오답은 복습 일정에 따라 일부씩 다시 나와요.
                    </p>
                  )}
                </div>
              </Section>

              <div style={{ flex: 1 }} />
              <BottomCta>
                <div style={{ display: 'flex', gap: 8 }}>
                  <ActionButton variant="secondary" onClick={() => void navigate('/wrong-notes')}>
                    오답노트
                  </ActionButton>
                  <ActionButton onClick={() => void navigate('/')}>홈으로</ActionButton>
                </div>
              </BottomCta>
            </>
          );
        }}
      </AsyncBoundary>
    </Screen>
  );
}
