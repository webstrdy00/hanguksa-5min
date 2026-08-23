import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { ApiError, request } from './client.ts';
import type {
  AnswerResponse,
  CompleteResponse,
  CorrectionNotice,
  ExamsResponse,
  FeatureFlag,
  ProgressResponse,
  ReportReason,
  SessionResponse,
  WrongNotesResponse,
} from './types.ts';

/**
 * 서버 상태 훅 (공통 02 §1: 서버 상태와 화면 상태 분리).
 *
 * 재시도 정책은 공통 05 §2 를 따른다.
 * **429/503 만** 자동 재시도한다. 409/422 는 상태를 갱신하고 사용자가 선택해야 한다.
 */

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof ApiError) return error.retryable;
  // 네트워크 오류는 한 번 더 시도해본다.
  return true;
}

export const queryKeys = {
  exams: ['exams'] as const,
  session: ['session', 'today'] as const,
  wrongNotes: (status: string, era: string | null) => ['wrong-notes', status, era] as const,
  progress: ['progress'] as const,
  corrections: ['corrections'] as const,
  flags: ['feature-flags'] as const,
};

export function useExams(enabled: boolean): UseQueryResult<ExamsResponse, unknown> {
  return useQuery({
    queryKey: queryKeys.exams,
    queryFn: () => request<ExamsResponse>('/v1/exams'),
    retry: shouldRetry,
    enabled,
  });
}

export function useUpdateGoal(): UseMutationResult<
  { goal: ExamsResponse['goal'] },
  unknown,
  { targetGrade?: number; targetExamId?: string }
> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body) =>
      request<{ goal: ExamsResponse['goal'] }>('/v1/profile/goal', { method: 'PATCH', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.exams });
    },
    retry: false,
  });
}

/**
 * 오늘 세션 시작/재사용.
 *
 * 서버가 UNIQUE(user_id, study_date) 로 멱등을 보장하므로 여러 번 호출해도 안전하다.
 * 그래도 화면에서 중복 호출이 나가지 않도록 쿼리로 감싼다.
 */
export function useTodaySession(enabled: boolean): UseQueryResult<SessionResponse, unknown> {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => request<SessionResponse>('/v1/study/today', { method: 'POST' }),
    retry: shouldRetry,
    enabled,
    // 재진입 시 서버 상태를 다시 확인한다.
    staleTime: 0,
  });
}

export function useSubmitAnswer(
  sessionId: string | undefined,
): UseMutationResult<
  AnswerResponse,
  unknown,
  { questionRevisionId: string; selectedIndex: number }
> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body) => {
      if (sessionId == null) throw new Error('세션이 없습니다.');
      return request<AnswerResponse>(`/v1/sessions/${sessionId}/answer`, { method: 'POST', body });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.session });
    },
    // 답안은 자동 재시도하지 않는다. 중복 제출로 보이지 않게 사용자가 결정한다.
    retry: false,
  });
}

export function useCompleteSession(
  sessionId: string | undefined,
): UseMutationResult<CompleteResponse, unknown, void> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => {
      if (sessionId == null) throw new Error('세션이 없습니다.');
      return request<CompleteResponse>(`/v1/sessions/${sessionId}/complete`, { method: 'POST' });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.session });
      void client.invalidateQueries({ queryKey: queryKeys.progress });
      void client.invalidateQueries({ queryKey: queryKeys.wrongNotes('all', null) });
    },
    retry: false,
  });
}

export function useWrongNotes(
  status: 'all' | 'unreviewed' | 'reviewed',
  era: string | null,
  enabled: boolean,
): UseQueryResult<WrongNotesResponse, unknown> {
  const params = new URLSearchParams({ status, limit: '50' });
  if (era != null) params.set('era', era);

  return useQuery({
    queryKey: queryKeys.wrongNotes(status, era),
    queryFn: () => request<WrongNotesResponse>(`/v1/wrong-notes?${params.toString()}`),
    retry: shouldRetry,
    enabled,
  });
}

export function useMarkReviewed(): UseMutationResult<unknown, unknown, string> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (canonicalQuestionId: string) =>
      request(`/v1/wrong-notes/${canonicalQuestionId}/review`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['wrong-notes'] });
    },
    retry: false,
  });
}

export function useProgress(enabled: boolean): UseQueryResult<ProgressResponse, unknown> {
  return useQuery({
    queryKey: queryKeys.progress,
    queryFn: () => request<ProgressResponse>('/v1/progress'),
    retry: shouldRetry,
    enabled,
  });
}

export function useCorrections(
  enabled: boolean,
): UseQueryResult<{ corrections: CorrectionNotice[] }, unknown> {
  return useQuery({
    queryKey: queryKeys.corrections,
    queryFn: () => request<{ corrections: CorrectionNotice[] }>('/v1/corrections'),
    retry: shouldRetry,
    enabled,
  });
}

export function useFeatureFlags(
  enabled: boolean,
): UseQueryResult<{ flags: FeatureFlag[] }, unknown> {
  return useQuery({
    queryKey: queryKeys.flags,
    queryFn: () => request<{ flags: FeatureFlag[] }>('/v1/feature-flags'),
    retry: shouldRetry,
    enabled,
  });
}

export function useReportQuestion(): UseMutationResult<
  { id: string; merged: boolean },
  unknown,
  { questionRevisionId: string; reason: ReportReason; detail?: string }
> {
  return useMutation({
    mutationFn: ({ questionRevisionId, reason, detail }) =>
      request<{ id: string; merged: boolean }>(`/v1/questions/${questionRevisionId}/report`, {
        method: 'POST',
        body: detail == null || detail.length === 0 ? { reason } : { reason, detail },
      }),
    retry: false,
  });
}
