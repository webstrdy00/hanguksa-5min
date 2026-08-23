import { TDSMobileAITProvider } from '@toss/tds-mobile-ait';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import config from '../apps-in-toss.config.ts';
import App from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';
import './index.css';

/**
 * 앱 진입점.
 *
 * 서버 상태(QueryClient)와 화면 상태를 분리한다 (공통 02 §1).
 * 재시도 정책은 각 훅에서 정한다. 여기서는 전역 기본값만 보수적으로 둔다.
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
    <TDSMobileAITProvider brandPrimaryColor={config.brand.primaryColor}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </TDSMobileAITProvider>
  </StrictMode>,
);
