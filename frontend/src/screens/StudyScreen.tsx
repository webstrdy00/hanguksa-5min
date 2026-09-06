import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSubmitAnswer, useTodaySession } from '../api/hooks.ts';
import { ERA_LABELS, TOPIC_LABELS, type SessionItem } from '../api/types.ts';
import { trackClick, trackOperational, trackScreen } from '../analytics/events.ts';
import { ReportDialog } from '../components/ReportDialog.tsx';
import {
  ActionButton,
  AsyncBoundary,
  BottomCta,
  EmptyState,
  ErrorState,
  MIN_TOUCH_SIZE,
  Screen,
  Section,
  StatusTag,
} from '../components/common.tsx';

/**
 * 문제 + 해설 (02 UX §3).
 *
 * 한 화면에서 "풀이 → 해설" 두 단계를 전환한다. 한 번에 하나의 행동만 강조한다.
 *
 * 지키는 것:
 * - 정답은 서버가 판정한다. 클라이언트는 correctIndex 를 답하기 전까지 갖고 있지 않다.
 * - 답안 제출 중에는 선택지를 잠가 중복 제출을 막는다 (02 UX §5).
 * - 정답/오답을 색만으로 구분하지 않는다. 기호와 텍스트를 함께 쓴다 (공통 05 §3).
 * - void 된 문항은 풀지 않고 넘어간다. 사용자 잘못이 아니다 (09 §2).
 */
export function StudyScreen(): JSX.Element {
  const navigate = useNavigate();
  const session = useTodaySession(true);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [reportTarget, setReportTarget] = useState<string | null>(null);

  const sessionId = session.data?.session.id;
  const submitAnswer = useSubmitAnswer(sessionId);

  useEffect(() => {
    trackScreen('study');
  }, []);

  const items = useMemo(() => session.data?.items ?? [], [session.data]);
  const current: SessionItem | undefined = items[cursor];

  /** 아직 답하지 않은 유효 문항이 있는지 */
  // 09 §2: 오류 문항이 사용자에게 노출된 사실을 운영 지표로 남긴다.
  useEffect(() => {
    if (current?.voided === true) {
      trackOperational('voided_question_seen', { slot_index: current.slotIndex });
    }
  }, [current]);

  const remaining = items.filter((item) => !item.voided && !item.answered).length;

  const goNext = (): void => {
    submitAnswer.reset();
    setSelected(null);

    const nextIndex = items.findIndex(
      (item, index) => index > cursor && !item.voided && !item.answered,
    );

    if (nextIndex === -1) {
      const anyLeft = items.findIndex((item) => !item.voided && !item.answered);
      if (anyLeft === -1) {
        void navigate('/result');
        return;
      }
      setCursor(anyLeft);
      return;
    }

    setCursor(nextIndex);
  };

  const submit = (): void => {
    if (current == null || selected == null) return;
    // 문항 원문이나 고른 답을 보내지 않는다. 진행 위치만 남긴다 (07 §7).
    trackClick('answer', { slot_index: current.slotIndex });
    submitAnswer.mutate({
      questionRevisionId: current.questionRevisionId,
      selectedIndex: selected,
    });
  };

  return (
    <Screen>
      <AsyncBoundary query={session} loadingLabel="오늘의 문제를 준비하고 있어요">
        {(data) => {
          if (data.session.completedAt != null && remaining === 0) {
            return (
              <EmptyState
                title="오늘 학습을 마쳤어요"
                description="복습은 오답노트에서 이어서 할 수 있어요."
                action={
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <ActionButton variant="secondary" onClick={() => void navigate('/wrong-notes')}>
                      오답노트
                    </ActionButton>
                    <ActionButton onClick={() => void navigate('/result')}>결과 보기</ActionButton>
                  </div>
                }
              />
            );
          }

          if (current == null) {
            return (
              <EmptyState
                title="표시할 문제가 없어요"
                action={<ActionButton onClick={() => void navigate('/')}>홈으로</ActionButton>}
              />
            );
          }

          const answer = submitAnswer.data;
          const showExplanation = answer != null || current.answered;
          const correctIndex = answer?.correctIndex ?? current.correctIndex;
          const explanation = answer?.explanation ?? current.explanation;
          const isCorrect = answer?.isCorrect ?? current.isCorrect;
          const chosen = current.answered ? (current.selectedIndex ?? selected) : selected;

          return (
            <>
              <Section>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingTop: 20,
                  }}
                >
                  <span style={{ fontSize: 14, color: '#6b7684' }}>
                    {cursor + 1} / {items.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => setReportTarget(current.questionRevisionId)}
                    style={{
                      minHeight: MIN_TOUCH_SIZE,
                      padding: '0 12px',
                      border: 'none',
                      background: 'none',
                      color: '#6b7684',
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    오류 제보
                  </button>
                </div>

                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={items.length}
                  aria-valuenow={cursor + 1}
                  style={{ height: 4, background: '#e5e8eb', borderRadius: 2, marginTop: 4 }}
                >
                  <div
                    style={{
                      width: `${((cursor + 1) / items.length) * 100}%`,
                      height: '100%',
                      background: '#3182f6',
                      borderRadius: 2,
                    }}
                  />
                </div>

                {current.voided ? (
                  <div style={{ marginTop: 24 }}>
                    <StatusTag tone="warning">확인 중인 문항</StatusTag>
                    <p style={{ color: '#4e5968', fontSize: 15, marginTop: 12 }}>
                      이 문항에서 오류가 확인돼 오늘 채점에서 제외했어요. 학습 완료와 연속 학습일은
                      그대로 유지돼요.
                    </p>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 6, marginTop: 20 }}>
                      <StatusTag tone="neutral">{ERA_LABELS[current.era] ?? current.era}</StatusTag>
                      <StatusTag tone="neutral">
                        {TOPIC_LABELS[current.topic] ?? current.topic}
                      </StatusTag>
                    </div>

                    <h1
                      style={{
                        fontSize: 19,
                        fontWeight: 700,
                        lineHeight: 1.5,
                        margin: '12px 0 20px',
                        wordBreak: 'keep-all',
                      }}
                    >
                      {current.prompt}
                    </h1>

                    <fieldset
                      disabled={showExplanation || submitAnswer.isPending}
                      style={{ border: 'none', padding: 0, margin: 0 }}
                    >
                      <legend className="sr-only">선택지</legend>
                      {current.choices.map((choice, index) => {
                        const isChosen = chosen === index;
                        const isAnswer = showExplanation && correctIndex === index;
                        const isWrongPick = showExplanation && isChosen && correctIndex !== index;

                        return (
                          <label
                            key={`${current.questionRevisionId}-${index}`}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 10,
                              padding: '14px 16px',
                              marginBottom: 8,
                              minHeight: MIN_TOUCH_SIZE,
                              borderRadius: 12,
                              border: `1px solid ${
                                isAnswer
                                  ? '#1b64da'
                                  : isWrongPick
                                    ? '#c23934'
                                    : isChosen
                                      ? '#3182f6'
                                      : '#e5e8eb'
                              }`,
                              background: isAnswer ? '#f0f6ff' : isWrongPick ? '#fff5f5' : '#fff',
                              cursor: showExplanation ? 'default' : 'pointer',
                            }}
                          >
                            <input
                              type="radio"
                              name={`choice-${current.questionRevisionId}`}
                              checked={isChosen}
                              onChange={() => setSelected(index)}
                              style={{ width: 20, height: 20, marginTop: 2 }}
                            />
                            <span
                              style={{
                                flex: 1,
                                fontSize: 15,
                                lineHeight: 1.5,
                                wordBreak: 'keep-all',
                              }}
                            >
                              {choice}
                            </span>
                            {/* 색만으로 구분하지 않는다 */}
                            {isAnswer && <StatusTag tone="correct">정답</StatusTag>}
                            {isWrongPick && <StatusTag tone="wrong">내 선택</StatusTag>}
                          </label>
                        );
                      })}
                    </fieldset>
                  </>
                )}

                {showExplanation && !current.voided && (
                  <div
                    style={{
                      marginTop: 20,
                      padding: 16,
                      borderRadius: 12,
                      background: '#f9fafb',
                    }}
                  >
                    <StatusTag tone={isCorrect === true ? 'correct' : 'wrong'}>
                      {isCorrect === true ? '맞았어요' : '틀렸어요'}
                    </StatusTag>
                    <p
                      style={{
                        margin: '12px 0 0',
                        fontSize: 15,
                        lineHeight: 1.6,
                        color: '#333d4b',
                        wordBreak: 'keep-all',
                      }}
                    >
                      {explanation}
                    </p>
                    {answer?.memoryKeyword != null && (
                      <p style={{ margin: '12px 0 0', fontSize: 14, color: '#6b7684' }}>
                        기억 키워드 · {answer.memoryKeyword}
                      </p>
                    )}
                  </div>
                )}

                {submitAnswer.isError && (
                  <ErrorState error={submitAnswer.error} onRetry={() => submitAnswer.reset()} />
                )}
              </Section>

              <div style={{ flex: 1 }} />

              <BottomCta>
                {current.voided ? (
                  <ActionButton onClick={goNext}>다음 문제</ActionButton>
                ) : showExplanation ? (
                  <ActionButton onClick={goNext}>
                    {remaining === 0 ? '결과 보기' : '다음 문제'}
                  </ActionButton>
                ) : (
                  <ActionButton
                    onClick={submit}
                    disabled={selected == null}
                    pending={submitAnswer.isPending}
                    pendingLabel="채점하고 있어요"
                  >
                    답 제출하기
                  </ActionButton>
                )}
              </BottomCta>
            </>
          );
        }}
      </AsyncBoundary>

      {reportTarget != null && (
        <ReportDialog questionRevisionId={reportTarget} onClose={() => setReportTarget(null)} />
      )}
    </Screen>
  );
}
