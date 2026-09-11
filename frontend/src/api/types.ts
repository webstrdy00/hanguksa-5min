/**
 * 서버 API 응답 타입 (08 §2, 공통 05 §2).
 *
 * 백엔드가 실제로 내려주는 형태를 그대로 옮긴다. 화면 편의를 위해 임의로 바꾸지 않는다.
 */

/** 공통 오류 envelope (공통 05 §2) */
export interface ErrorEnvelope {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
  details?: unknown;
}

export interface BootstrapResponse {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface ExamView {
  id: string;
  type: string;
  round: number;
  examDate: string;
  status: string;
  /** 남은 일수. 시험 당일은 0, 지났으면 음수. 서버 KST 기준이다. */
  dday: number;
  selectable: boolean;
}

export interface GoalView {
  targetGrade: number | null;
  exam: ExamView | null;
  /** 목표 회차가 지났거나 취소돼 다시 골라야 하는 상태 (08 §4) */
  needsReselection: boolean;
}

export interface ExamsResponse {
  /** 서버 KST 기준 오늘. 클라이언트 시계를 쓰지 않는다. */
  today: string;
  exams: ExamView[];
  goal: GoalView;
}

export interface SessionItem {
  slotIndex: number;
  slotSource: string;
  questionRevisionId: string;
  era: string;
  topic: string;
  difficulty: number;
  prompt: string;
  choices: string[];
  voided: boolean;
  answered: boolean;
  selectedIndex?: number;
  isCorrect?: boolean;
  /** 답한 문항에만 내려온다. 풀기 전에는 서버가 보내지 않는다. */
  correctIndex?: number;
  explanation?: string;
}

export interface SessionResponse {
  session: {
    id: string;
    studyDate: string;
    completedAt: string | null;
    score: number | null;
    createdAt: string;
  };
  items: SessionItem[];
}

export interface AnswerResponse {
  isCorrect: boolean;
  correctIndex: number;
  explanation: string;
  wrongAnswerNotes: string[] | null;
  memoryKeyword: string | null;
  answeredCount: number;
  validCount: number;
  replayed: boolean;
}

export interface CompleteResponse {
  session: { id: string; studyDate: string; score: number; completedAt: string };
  streak: { days: number; lastStreakDate: string };
  validCount: number;
  alreadyCompleted: boolean;
}

export interface WrongNoteItem {
  canonicalQuestionId: string;
  questionRevisionId: string;
  era: string;
  topic: string;
  difficulty: number;
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  memoryKeyword: string | null;
  selectedIndex: number;
  wrongCount: number;
  intervalStep: number;
  reviewDueAt: string | null;
  lastSeenAt: string;
  lastReviewedAt: string | null;
  reviewed: boolean;
  retired: boolean;
}

export interface WrongNotesResponse {
  items: WrongNoteItem[];
  page: number;
  limit: number;
  total: number;
}

export type ProgressStatus = 'insufficient_data' | 'weak' | 'normal';

export interface TopicProgress {
  topic: string;
  seenCount: number;
  correctCount: number;
  /** 07 §3: 노출 5회 미만이면 서버가 null 로 내려준다. */
  accuracyPercent: number | null;
  status: ProgressStatus;
}

export interface EraProgress {
  era: string;
  seenCount: number;
  correctCount: number;
  accuracyPercent: number | null;
  status: ProgressStatus;
  topics: TopicProgress[];
}

export interface ProgressResponse {
  eras: EraProgress[];
  summary: {
    totalSeen: number;
    totalCorrect: number;
    accuracyPercent: number | null;
    weakEras: string[];
  };
  streak: { days: number; lastStreakDate: string | null };
  recentDays: {
    studyDate: string;
    completed: boolean;
    score: number | null;
    answeredCount: number;
  }[];
}

export interface CorrectionNotice {
  id: string;
  questionId: string;
  noticeType: string;
  message: string;
  publishedAt: string;
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
}

export const REPORT_REASONS = [
  'wrong_answer',
  'ambiguous',
  'typo',
  'outdated',
  'rights',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  wrong_answer: '정답이 틀린 것 같아요',
  ambiguous: '답이 여러 개로 보여요',
  typo: '오타가 있어요',
  outdated: '최신 내용과 달라요',
  rights: '자료 출처가 걱정돼요',
  other: '기타',
};

/** 04 §2 시대 코드 → 화면 라벨 */
export const ERA_LABELS: Record<string, string> = {
  prehistoric: '선사',
  ancient: '고대',
  goryeo: '고려',
  joseon_early: '조선전기',
  joseon_late: '조선후기',
  enlightenment: '개항기',
  japanese_occupation: '일제강점',
  modern: '현대',
};

export const TOPIC_LABELS: Record<string, string> = {
  politics: '정치',
  economy: '경제',
  society: '사회',
  culture: '문화',
  figure: '인물',
  heritage: '유산',
};
