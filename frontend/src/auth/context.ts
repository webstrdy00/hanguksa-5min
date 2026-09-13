import { createContext, useContext } from 'react';

export type AuthStatus = 'idle' | 'authenticating' | 'authenticated' | 'failed';

export interface AuthState {
  status: AuthStatus;
  /** 화면에서 오류 종류와 재시도 안내를 유지한다. */
  error: Error | null;
  retry: () => void;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value == null) throw new Error('AuthProvider 안에서만 사용할 수 있어요.');
  return value;
}
