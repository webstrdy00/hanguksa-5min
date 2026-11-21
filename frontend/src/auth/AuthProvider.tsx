import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import {
  ApiError,
  NetworkError,
  RequestTimeoutError,
  ResponseFormatError,
  request,
  setAccessToken,
  setReauthorizer,
  withNetworkTimeout,
} from '../api/client.ts';
import type { BootstrapResponse } from '../api/types.ts';
import { AuthContext, type AuthState, type AuthStatus } from './context.ts';
import { AuthInitializationError } from './errors.ts';
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
  const active = useRef(false);
  const cancelBackoff = useRef<(() => void) | null>(null);

  const bootstrap = useCallback(async (): Promise<string | null> => {
    if (!active.current) return null;
    // 동시에 여러 요청이 401 을 받아도 bootstrap 은 한 번만 돈다.
    if (inFlight.current != null) return await inFlight.current;

    const run = (async (): Promise<string | null> => {
      try {
        let anonKey: string;
        try {
          anonKey = await withNetworkTimeout(() => adapter.getAnonymousKey());
        } catch (caught) {
          throw new AuthInitializationError(
            caught instanceof RequestTimeoutError
              ? 'AUTH_IDENTITY_TIMEOUT'
              : 'AUTH_IDENTITY_FAILED',
          );
        }
        if (typeof anonKey !== 'string' || anonKey.trim().length === 0) {
          throw new AuthInitializationError('AUTH_IDENTITY_FAILED');
        }

        // 429/503만 1초, 2초 후 재시도한다. 식별키는 같은 bootstrap 안에서 재사용한다.
        for (let attempt = 0; ; attempt += 1) {
          if (!active.current) return null;
          try {
            const result = await request<BootstrapResponse>('/v1/auth/bootstrap', {
              method: 'POST',
              authorized: false,
              body: { anonKey },
            });

            if (!active.current) return null;
            const token = result?.accessToken;
            if (typeof token !== 'string' || token.length === 0 || /[^\x21-\x7e]/.test(token)) {
              throw new AuthInitializationError('AUTH_RESPONSE_INVALID');
            }
            setAccessToken(token);
            setStatus('authenticated');
            setError(null);
            return token;
          } catch (caught) {
            if (
              !(caught instanceof ApiError) ||
              (caught.status !== 429 && caught.status !== 503) ||
              attempt >= 2
            ) {
              throw caught;
            }
            if (!active.current) return null;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(
                () => {
                  cancelBackoff.current = null;
                  resolve();
                },
                1_000 * 2 ** attempt,
              );
              cancelBackoff.current = () => {
                clearTimeout(timer);
                cancelBackoff.current = null;
                resolve();
              };
            });
          }
        }
      } catch (caught) {
        if (!active.current) return null;
        setAccessToken(null);
        setStatus('failed');

        if (
          caught instanceof NetworkError ||
          caught instanceof ApiError ||
          caught instanceof AuthInitializationError
        ) {
          setError(caught);
        } else if (caught instanceof ResponseFormatError) {
          setError(new AuthInitializationError('AUTH_RESPONSE_INVALID'));
        } else {
          setError(new AuthInitializationError('AUTH_BOOTSTRAP_FAILED'));
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
    active.current = true;
    setReauthorizer(bootstrap);
    return () => {
      active.current = false;
      cancelBackoff.current?.();
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
