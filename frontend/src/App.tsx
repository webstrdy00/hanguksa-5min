import { Navigate, Route, Routes } from 'react-router-dom';
import { useExams } from './api/hooks.ts';
import { useAuth } from './auth/AuthProvider.tsx';
import {
  ActionButton,
  ErrorState,
  LoadingState,
  Screen,
  Section,
  UnofficialNotice,
} from './components/common.tsx';
import { HomeScreen } from './screens/HomeScreen.tsx';
import { OnboardingScreen } from './screens/OnboardingScreen.tsx';
import { ProgressScreen } from './screens/ProgressScreen.tsx';
import { ResultScreen } from './screens/ResultScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import { StudyScreen } from './screens/StudyScreen.tsx';
import { WrongNotesScreen } from './screens/WrongNotesScreen.tsx';

/**
 * 화면 라우팅 (02 UX §1 정보 구조).
 *
 * 첫 진입 → 목표 설정 → 오늘 5문제 → 결과
 * 재방문 → 홈 → 오늘 5문제
 *
 * 로그인/회원가입 화면은 만들지 않는다. 식별은 bootstrap 이 이미 끝냈다.
 */
export default function App(): JSX.Element {
  const auth = useAuth();

  if (auth.status === 'authenticating' || auth.status === 'idle') {
    return (
      <Screen>
        <LoadingState label="준비하고 있어요" />
      </Screen>
    );
  }

  if (auth.status === 'failed') {
    return (
      <Screen>
        <Section>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginTop: 40 }}>지금은 시작할 수 없어요</h1>
        </Section>
        <ErrorState error={new Error(auth.error?.message ?? '')} />
        <Section>
          <ActionButton onClick={auth.retry}>다시 시도</ActionButton>
        </Section>
        <UnofficialNotice />
      </Screen>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<EntryRoute />} />
      <Route path="/onboarding" element={<OnboardingScreen />} />
      <Route path="/study" element={<StudyScreen />} />
      <Route path="/result" element={<ResultScreen />} />
      <Route path="/wrong-notes" element={<WrongNotesScreen />} />
      <Route path="/progress" element={<ProgressScreen />} />
      <Route path="/settings" element={<SettingsScreen />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * 첫 화면 분기.
 * 목표를 한 번도 고르지 않았으면 온보딩으로 보낸다.
 * 목표가 만료된 경우는 홈에서 "다시 고르기"로 안내한다 (08 §4).
 */
function EntryRoute(): JSX.Element {
  const exams = useExams(true);

  if (exams.isPending) {
    return (
      <Screen>
        <LoadingState label="오늘 할 일을 불러오고 있어요" />
      </Screen>
    );
  }

  if (exams.isError) {
    return (
      <Screen>
        <ErrorState
          error={exams.error}
          onRetry={() => {
            exams.refetch();
          }}
        />
      </Screen>
    );
  }

  const goal = exams.data?.goal;
  const neverChosen = goal?.targetGrade == null && goal?.exam == null;

  if (neverChosen) return <Navigate to="/onboarding" replace />;

  return <HomeScreen />;
}
