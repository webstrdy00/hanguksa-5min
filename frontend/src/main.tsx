import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';
import './index.css';

/**
 * 앱 진입점.
 *
 * 서버 상태(QueryClient)와 화면 상태를 분리한다 (공통 02 §1).
 * 재시도 정책은 각 훅에서 정한다. 여기서는 전역 기본값만 보수적으로 둔다.
 *
 * TDS 를 쓰지 않는다.
 * TDSMobileAITProvider 는 safe-area CSS 변수와 브랜드 컬러 토큰만 주는데,
 * 화면은 표준 env(safe-area-inset-*) 와 색상값을 직접 쓰고 있어 쓸모가 없었다.
 * 그 Provider 하나 때문에 tds-mobile 배럴 전체가 실려 시작 시간을 깎아먹었다.
 * 미니앱은 시작 시간이 심사 항목이라(공통 07 §2) 제거했다.
 * TDS 컴포넌트가 실제로 필요해지면 그때 해당 화면에서만 lazy 로 불러온다.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 느린 네트워크에서 화면이 깜빡이지 않게 잠깐 캐시를 유지한다.
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: false,
    },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
