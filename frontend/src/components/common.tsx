import type { PropsWithChildren, ReactNode } from 'react';
import { ApiError, NetworkError } from '../api/client.ts';

/**
 * 공통 UI 조각 (공통 05 §3 접근성 P0, 02 UX §5).
 *
 * 여기서 강제하는 것:
 * - loading / empty / error 상태를 화면마다 빠뜨리지 않게 한 곳에 모은다.
 * - 오류를 토스트로 흘려보내지 않고 **재시도 경로**를 함께 준다.
 * - 색만으로 상태를 구분하지 않는다. 항상 텍스트와 기호를 함께 쓴다.
 * - 터치 영역은 최소 44px 를 유지한다.
 */

export const MIN_TOUCH_SIZE = 44;

export function Screen({ children }: PropsWithChildren): JSX.Element {
  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100dvh',
        // 하단 안전영역. CTA 가 홈 인디케이터에 가리지 않게 한다 (02 UX §5).
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
      }}
    >
      {children}
    </main>
  );
}

export function Section({ children }: PropsWithChildren): JSX.Element {
  return <section style={{ padding: '0 20px' }}>{children}</section>;
}

export function LoadingState({ label }: { label: string }): JSX.Element {
  return (
    <div role="status" aria-live="polite" style={{ padding: 24, color: '#6b7684' }}>
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div style={{ padding: '32px 20px', textAlign: 'center', color: '#6b7684' }}>
      <p style={{ fontSize: 16, fontWeight: 600, color: '#333d4b', margin: '0 0 8px' }}>{title}</p>
      {description != null && <p style={{ fontSize: 14, margin: '0 0 16px' }}>{description}</p>}
      {action}
    </div>
  );
}

function describeError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof NetworkError) return { message: error.message, retryable: true };
  if (error instanceof ApiError) return { message: error.message, retryable: error.retryable };
  return { message: '알 수 없는 오류가 발생했어요.', retryable: true };
}

/**
 * 오류 표시.
 * 문서 요구대로 사라지는 토스트가 아니라 **화면에 남고 재시도 버튼을 준다** (공통 05 §3).
 */
export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): JSX.Element {
  const { message, retryable } = describeError(error);

  return (
    <div
      role="alert"
      style={{
        margin: '16px 20px',
        padding: 16,
        borderRadius: 12,
        border: '1px solid #f4c7c3',
        background: '#fff5f5',
      }}
    >
      <p style={{ margin: '0 0 12px', color: '#c23934', fontSize: 15 }}>⚠ {message}</p>
      {onRetry != null && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            minHeight: MIN_TOUCH_SIZE,
            padding: '0 16px',
            borderRadius: 8,
            border: '1px solid #c23934',
            background: '#fff',
            color: '#c23934',
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {retryable ? '다시 시도' : '새로고침'}
        </button>
      )}
    </div>
  );
}

/** 로딩·오류·빈 상태를 한 번에 다루는 경계. 화면마다 반복하지 않는다. */
export function AsyncBoundary<T>({
  query,
  loadingLabel,
  empty,
  children,
}: {
  query: {
    data: T | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => void;
  };
  loadingLabel: string;
  empty?: (data: T) => ReactNode | null;
  children: (data: T) => ReactNode;
}): JSX.Element {
  if (query.isPending) return <LoadingState label={loadingLabel} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          query.refetch();
        }}
      />
    );
  }
  if (query.data === undefined) return <LoadingState label={loadingLabel} />;

  const emptyNode = empty?.(query.data);
  if (emptyNode != null) return <>{emptyNode}</>;

  return <>{children(query.data)}</>;
}

/**
 * 국사편찬위원회 공식 서비스가 아니라는 고지 (09 §4, 하드게이트 P0).
 * 첫 화면과 설정에 반드시 노출한다.
 */
export function UnofficialNotice({ compact = false }: { compact?: boolean }): JSX.Element {
  return (
    <p
      style={{
        margin: compact ? '8px 20px 0' : '16px 20px',
        padding: compact ? 0 : '12px 14px',
        borderRadius: 8,
        background: compact ? 'transparent' : '#f2f4f6',
        color: '#6b7684',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      국사편찬위원회 공식 서비스가 아닌 비공식 학습 보조 서비스예요.
    </p>
  );
}

/** 상태를 색이 아니라 텍스트와 기호로 구분한다 (공통 05 §3). */
export function StatusTag({
  tone,
  children,
}: PropsWithChildren<{ tone: 'correct' | 'wrong' | 'neutral' | 'warning' }>): JSX.Element {
  const styles: Record<typeof tone, { background: string; color: string; mark: string }> = {
    correct: { background: '#e8f3ff', color: '#1b64da', mark: '○' },
    wrong: { background: '#fff0f0', color: '#c23934', mark: '×' },
    neutral: { background: '#f2f4f6', color: '#4e5968', mark: '·' },
    warning: { background: '#fff8e1', color: '#8a6100', mark: '!' },
  };
  const style = styles[tone];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 6,
        background: style.background,
        color: style.color,
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      <span aria-hidden="true">{style.mark}</span>
      {children}
    </span>
  );
}

/**
 * 기본 버튼.
 * 중복 제출을 막기 위해 pending 중에는 비활성화하고 문구로 진행 상태를 알린다 (02 UX §5).
 */
export function ActionButton({
  onClick,
  disabled = false,
  pending = false,
  pendingLabel = '처리 중이에요',
  variant = 'primary',
  children,
}: PropsWithChildren<{
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary';
}>): JSX.Element {
  const isPrimary = variant === 'primary';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      aria-busy={pending}
      style={{
        width: '100%',
        minHeight: 52,
        borderRadius: 12,
        border: isPrimary ? 'none' : '1px solid #d1d6db',
        background: disabled || pending ? '#d1d6db' : isPrimary ? '#3182f6' : '#fff',
        color: isPrimary ? '#fff' : '#4e5968',
        fontSize: 17,
        fontWeight: 700,
        cursor: disabled || pending ? 'not-allowed' : 'pointer',
      }}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

/** 하단 고정 CTA. 키보드가 올라와도 가려지지 않게 safe-area 를 더한다. */
export function BottomCta({ children }: PropsWithChildren): JSX.Element {
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        padding: '12px 20px calc(env(safe-area-inset-bottom, 0px) + 12px)',
        background: 'linear-gradient(to top, #fff 70%, rgba(255,255,255,0))',
      }}
    >
      {children}
    </div>
  );
}
