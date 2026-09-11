import { useState } from 'react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { trackScreen } from '../analytics/events.ts';
import { useExams, useUpdateGoal } from '../api/hooks.ts';
import {
  ActionButton,
  AsyncBoundary,
  BottomCta,
  EmptyState,
  ErrorState,
  MIN_TOUCH_SIZE,
  Screen,
  Section,
  UnofficialNotice,
} from '../components/common.tsx';

/**
 * 온보딩 (02 UX §3).
 *
 * 선택은 3단계 이내로 끝낸다: 목표 급수 → 시험 회차 → 바로 시작.
 * 사전 실력 테스트는 V1 에서 생략한다.
 * 로그인/회원가입 화면은 없다. 식별은 bootstrap 이 이미 끝냈다.
 */

const GRADES = [
  { value: 1, label: '1급', description: '가장 높은 등급을 목표로 해요' },
  { value: 2, label: '2급', description: '무난하게 준비하고 있어요' },
  { value: 3, label: '3급', description: '기초부터 차근차근 할래요' },
] as const;

export function OnboardingScreen(): JSX.Element {
  const navigate = useNavigate();
  const exams = useExams(true);
  const updateGoal = useUpdateGoal();

  useEffect(() => {
    trackScreen('onboarding');
  }, []);

  const [grade, setGrade] = useState<number | null>(null);
  const [examId, setExamId] = useState<string | null>(null);

  const submit = (): void => {
    if (grade == null || examId == null) return;

    updateGoal.mutate(
      { targetGrade: grade, targetExamId: examId },
      { onSuccess: () => void navigate('/', { replace: true }) },
    );
  };

  return (
    <Screen>
      <Section>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '32px 0 8px', lineHeight: 1.35 }}>
          시험일까지
          <br />
          하루 5분이면 충분해요
        </h1>
        <p style={{ color: '#6b7684', fontSize: 15, margin: '0 0 8px' }}>
          목표를 고르면 매일 5문제를 준비해 드려요.
        </p>
      </Section>
      <UnofficialNotice compact />

      <AsyncBoundary query={exams} loadingLabel="시험 일정을 불러오고 있어요">
        {(data) => {
          const selectable = data.exams.filter((exam) => exam.selectable);

          return (
            <>
              <Section>
                <h2 style={{ fontSize: 17, fontWeight: 700, margin: '28px 0 12px' }}>
                  목표 급수를 골라주세요
                </h2>
                <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
                  <legend className="sr-only">목표 급수</legend>
                  {GRADES.map((item) => (
                    <label
                      key={item.value}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        minHeight: 64,
                        padding: '0 16px',
                        marginBottom: 8,
                        borderRadius: 12,
                        border: `1px solid ${grade === item.value ? '#3182f6' : '#e5e8eb'}`,
                        background: grade === item.value ? '#f0f6ff' : '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="radio"
                        name="grade"
                        checked={grade === item.value}
                        onChange={() => setGrade(item.value)}
                        style={{ width: 20, height: 20 }}
                      />
                      <span>
                        <strong style={{ display: 'block', fontSize: 16 }}>
                          심화 {item.label}
                        </strong>
                        <span style={{ color: '#6b7684', fontSize: 13 }}>{item.description}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              </Section>

              <Section>
                <h2 style={{ fontSize: 17, fontWeight: 700, margin: '28px 0 12px' }}>
                  목표 회차를 골라주세요
                </h2>

                {selectable.length === 0 ? (
                  <EmptyState
                    title="지금 신청할 수 있는 회차가 없어요"
                    description="공식 일정이 올라오면 알려드릴게요."
                  />
                ) : (
                  <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
                    <legend className="sr-only">목표 회차</legend>
                    {selectable.map((exam) => (
                      <label
                        key={exam.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          minHeight: MIN_TOUCH_SIZE + 16,
                          padding: '0 16px',
                          marginBottom: 8,
                          borderRadius: 12,
                          border: `1px solid ${examId === exam.id ? '#3182f6' : '#e5e8eb'}`,
                          background: examId === exam.id ? '#f0f6ff' : '#fff',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="radio"
                          name="exam"
                          checked={examId === exam.id}
                          onChange={() => setExamId(exam.id)}
                          style={{ width: 20, height: 20 }}
                        />
                        <span>
                          <strong style={{ display: 'block', fontSize: 16 }}>
                            제{exam.round}회 심화
                          </strong>
                          <span style={{ color: '#6b7684', fontSize: 13 }}>
                            {exam.examDate} · D-{exam.dday}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
              </Section>

              {updateGoal.isError && <ErrorState error={updateGoal.error} />}

              <div style={{ flex: 1 }} />
              <BottomCta>
                <ActionButton
                  onClick={submit}
                  disabled={grade == null || examId == null}
                  pending={updateGoal.isPending}
                  pendingLabel="저장하고 있어요"
                >
                  바로 시작하기
                </ActionButton>
              </BottomCta>
            </>
          );
        }}
      </AsyncBoundary>
    </Screen>
  );
}
