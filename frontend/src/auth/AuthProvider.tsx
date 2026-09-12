import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import {
  ApiError,
  NetworkError,
  request,
  setAccessToken,
  setReauthorizer,
  withNetworkTimeout,
} from '../api/client.ts';
import type { BootstrapResponse } from '../api/types.ts';
import { AuthContext, type AuthState, type AuthStatus } from './context.ts';
import { createIdentityAdapter } from './identity.ts';

/**
 * 인증 상태 (공통 06 §1).
 *
 * - 내부 access token 은 **메모리에만** 둔다. reload 하면 bootstrap 을 다시 한다.
 * - 401 이면 refresh 가 아니라 bootstrap 재수행이다.
 * - 검증 실패(401)와 일시 장애(503)를 구분해 사용자에게 다르게 안내한다.
 */

export function AuthProvider({ children }: PropsWithChildren): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('idle');
  const [error, setError] = useState<AuthState['error']>(null);
  const adapter = useMemo(() => createIdentityAdapter(), []);
  const inFlight = useRef<Promise<string | null> | null>(null);

  const bootstrap = useCallback(async (): Promise<string | null> => {
    // 동시에 여러 요청이 401 을 받아도 bootstrap 은 한 번만 돈다.
    if (inFlight.current != null) return await inFlight.current;

    const run = (async (): Promise<string | null> => {
      try {
        const anonKey = await withNetworkTimeout(() => adapter.getAnonymousKey());
        const result = await request<BootstrapResponse>('/v1/auth/bootstrap', {
          method: 'POST',
          authorized: false,
          body: { anonKey },
        });

        setAccessToken(result.accessToken);
        setStatus('authenticated');
        setError(null);
        return result.accessToken;
      } catch (caught) {
        setAccessToken(null);
        setStatus('failed');

        if (caught instanceof NetworkError || caught instanceof ApiError) {
          setError(caught);
        } else {
          setError(new Error('알 수 없는 오류가 발생했어요.'));
        }
        return null;
      } finally {
        inFlight.current = null;
      }
    })();

    inFlight.current = run;
    return await run;
  }, [adapter]);

  useEffect(() => {
    setReauthorizer(bootstrap);
    return () => {
      setReauthorizer(null);
    };
  }, [bootstrap]);

  useEffect(() => {
    setStatus('authenticating');
    void bootstrap();
  }, [bootstrap]);

  const retry = useCallback(() => {
    setStatus('authenticating');
    setError(null);
    void bootstrap();
  }, [bootstrap]);

  const value = useMemo<AuthState>(() => ({ status, error, retry }), [status, error, retry]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
