import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, ResponseFormatError } from '../api/client.ts';
import { AuthInitializationError } from '../auth/errors.ts';
import { ErrorState } from './common.tsx';

afterEach(cleanup);

it('응답 해석 실패를 일반 오류와 구분하고 재시도 경로를 제공한다', () => {
  const retry = vi.fn();
  render(<ErrorState error={new ResponseFormatError()} onRetry={retry} />);
  expect(screen.getByRole('alert').textContent).toContain('서버 응답을 확인할 수 없어요.');
  expect(screen.getByRole('alert').textContent).not.toContain('알 수 없는 오류');
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(retry).toHaveBeenCalledTimes(1);
});

it('알 수 없는 오류의 식별키와 토큰 원문은 화면에 표시하지 않는다', () => {
  const error = new Error('MOCK-private-anon-key MOCK-private-access-token');
  render(<ErrorState error={error} />);
  expect(screen.getByRole('alert').textContent).toContain('알 수 없는 오류가 발생했어요.');
  expect(document.body.textContent).not.toContain('MOCK-private-anon-key');
  expect(document.body.textContent).not.toContain('MOCK-private-access-token');
});

it('인증 단계 코드는 안전한 안내와 함께 표시한다', () => {
  render(<ErrorState error={new AuthInitializationError('AUTH_IDENTITY_FAILED')} />);
  expect(screen.getByRole('alert').textContent).toContain(
    '토스 사용자 식별 정보를 확인할 수 없어요.',
  );
  expect(screen.getByRole('alert').textContent).toContain('AUTH_IDENTITY_FAILED');
});

it('서버가 재시도 불가로 판정한 오류의 새로고침 동작을 유지한다', () => {
  const refresh = vi.fn();
  const error = new ApiError(422, {
    code: 'ANSWER_ALREADY_SUBMITTED',
    message: '이미 제출한 답안이에요.',
    requestId: 'MOCK-request-id',
    retryable: false,
  });
  render(<ErrorState error={error} onRetry={refresh} />);
  expect(screen.getByRole('alert').textContent).toContain('이미 제출한 답안이에요.');
  expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
  expect(refresh).toHaveBeenCalledTimes(1);
});
