import { beforeEach, expect, it, vi } from 'vitest';
import { AppError } from '../http/errors.ts';
import { getDeletionQueueHealth } from './deletion.ts';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn<() => Promise<unknown[]>>(),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('../db/client.ts', () => ({ db: { select: mocks.select } }));
vi.mock('../deletion-journal/runtime.ts', () => ({
  assertDeletionJournalBinding: vi.fn(),
  getDeletionJournal: vi.fn(),
  recordDeletionIntent: vi.fn(),
}));
vi.mock('../observability/logger.ts', () => ({ logger: mocks.logger }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ where: mocks.where });
});

it.each([
  { pending: 0, failed: 0, overdue: 0 },
  { pending: 5, failed: 2, overdue: 3 },
  { pending: 1, failed: 1, overdue: 1 },
  { pending: Number.MAX_SAFE_INTEGER, failed: 0, overdue: Number.MAX_SAFE_INTEGER },
])('검증된 실제 집계 행을 반환한다: %j', async (health) => {
  mocks.where.mockResolvedValueOnce([health]);
  await expect(getDeletionQueueHealth()).resolves.toEqual(health);
  expect(mocks.select).toHaveBeenCalledTimes(1);
  expect(mocks.from).toHaveBeenCalledTimes(1);
  expect(mocks.where).toHaveBeenCalledTimes(1);
});

async function expectUnavailable(): Promise<void> {
  const result = getDeletionQueueHealth();
  await expect(result).rejects.toBeInstanceOf(AppError);
  await expect(result).rejects.toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'DEPENDENCY_UNAVAILABLE',
    status: 503,
    details: undefined,
  });
  await expect(result).rejects.not.toHaveProperty('cause');
  expect(mocks.logger.info).not.toHaveBeenCalled();
  expect(mocks.logger.error).not.toHaveBeenCalled();
}

it.each([
  { name: '집계 행 누락', rows: [] },
  { name: 'null 집계 행', rows: [null] },
  { name: '빈 집계 행', rows: [{}] },
])('$name 결과를 빈 큐로 취급하지 않는다', async ({ rows }) => {
  mocks.where.mockResolvedValueOnce(rows);
  await expectUnavailable();
});

const invalidCounts = [
  { name: 'null', value: null },
  { name: '누락', value: undefined },
  { name: '음수', value: -1 },
  { name: '소수', value: 0.5 },
  { name: '숫자 문자열', value: '0' },
  { name: '민감 문자열', value: 'MOCK private queue payload' },
  { name: 'NaN', value: NaN },
  { name: '무한대', value: Infinity },
  { name: '안전 정수 초과', value: Number.MAX_SAFE_INTEGER + 1 },
];

it.each(
  (['pending', 'failed', 'overdue'] as const).flatMap((field) =>
    invalidCounts.map(({ name, value }) => ({ field, name, value })),
  ),
)('$field의 $name 집계를 원문 없이 거부한다', async ({ field, value }) => {
  mocks.where.mockResolvedValueOnce([{ pending: 1, failed: 0, overdue: 0, [field]: value }]);
  await expectUnavailable();
});

it.each([
  { pending: 0, failed: 1, overdue: 0 },
  { pending: 0, failed: 0, overdue: 1 },
])('전체 대기 건수를 초과하는 부분 집계는 거부한다: %j', async (health) => {
  mocks.where.mockResolvedValueOnce([health]);
  await expectUnavailable();
});

it('DB 조회 실패를 빈 큐로 숨기거나 새 오류로 교체하지 않는다', async () => {
  const error = new Error('MOCK database unavailable');
  mocks.where.mockRejectedValueOnce(error);
  await expect(getDeletionQueueHealth()).rejects.toBe(error);
  expect(mocks.where).toHaveBeenCalledTimes(1);
});
