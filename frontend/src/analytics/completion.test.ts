import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/hooks.ts';
import type { SessionResponse } from '../api/types.ts';

const { log } = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('@apps-in-toss/web-framework', () => ({ Analytics: { log } }));

let reportDailyStudyCompletion: typeof import('./completion.ts').reportDailyStudyCompletion;
let client: QueryClient;

function signal(sessionId = 'MOCK-session') {
  return { sessionId, score: 4, validCount: 5, streakDays: 3 };
}

function selectSession(sessionId = 'MOCK-session') {
  client.setQueryData<SessionResponse>(queryKeys.session, {
    session: {
      id: sessionId,
      studyDate: '2026-10-05',
      completedAt: '2026-10-05T01:00:00Z',
      score: 4,
      createdAt: '2026-10-05T00:00:00Z',
    },
    items: [],
  });
}

async function settleSdk() {
  // SDK -> safeLog -> ledger are two separate Promise continuations.
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  // Production has no reset API: module reload models a new browser document.
  vi.resetModules();
  ({ reportDailyStudyCompletion } = await import('./completion.ts'));
  log.mockReset().mockResolvedValue(undefined);
  client = new QueryClient();
  selectSession();
});

describe('document-only daily-study completion delivery', () => {
  it('sends only aggregate strings even if the signal has identifiers and content', async () => {
    const largerObject = {
      ...signal(),
      userId: 'MOCK-user',
      anonKey: 'MOCK-anon',
      accessToken: 'MOCK-token',
      questionRevisionId: 'MOCK-question',
      prompt: 'MOCK prompt',
      choices: ['MOCK choice'],
      selectedIndex: 2,
      answer: 'MOCK answer',
    };
    reportDailyStudyCompletion(client, largerObject);
    await settleSdk();

    expect(log).toHaveBeenCalledExactlyOnceWith({
      log_name: 'complete_daily_study',
      log_type: 'event',
      params: { score: '4', valid_count: '5', streak_days: '3' },
    });
  });

  it('deduplicates unresolved calls and SDK-resolved replays', async () => {
    let resolve!: () => void;
    log.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    reportDailyStudyCompletion(client, signal());
    for (let replay = 0; replay < 10; replay++) {
      reportDailyStudyCompletion(client, signal());
    }
    expect(log).toHaveBeenCalledTimes(1);

    resolve();
    await settleSdk();
    reportDailyStudyCompletion(client, signal());
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('leaves rejection pending until another observation, then deduplicates success', async () => {
    log.mockRejectedValueOnce(new Error('MOCK SDK reject'));
    reportDailyStudyCompletion(client, signal());
    await settleSdk();
    expect(log).toHaveBeenCalledTimes(1);

    reportDailyStudyCompletion(client, { sessionId: 'MOCK-session', score: 4, validCount: 5 });
    await settleSdk();
    reportDailyStudyCompletion(client, signal());
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith({
      log_name: 'complete_daily_study',
      log_type: 'event',
      params: { score: '4', valid_count: '5', streak_days: '3' },
    });
  });

  it('treats a synchronous SDK throw as retryable without throwing to the caller', async () => {
    log.mockImplementationOnce(() => {
      throw new Error('MOCK SDK throw');
    });
    expect(() => reportDailyStudyCompletion(client, signal())).not.toThrow();
    await settleSdk();
    reportDailyStudyCompletion(client, signal());
    await settleSdk();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('caps repeated failures at three attempts per retained session', async () => {
    log.mockRejectedValue(new Error('MOCK SDK remains offline'));
    for (let observation = 0; observation < 10; observation++) {
      reportDailyStudyCompletion(client, signal());
      await settleSdk();
    }
    log.mockResolvedValue(undefined);
    reportDailyStudyCompletion(client, signal());
    await settleSdk();
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('omits unavailable streak and keeps zero-valued completed aggregates', async () => {
    reportDailyStudyCompletion(client, { sessionId: 'MOCK-session', score: 0, validCount: 0 });
    await settleSdk();
    expect(log).toHaveBeenCalledExactlyOnceWith({
      log_name: 'complete_daily_study',
      log_type: 'event',
      params: { score: '0', valid_count: '0' },
    });
  });

  it('discards late signals for a replaced or removed session without consuming the new session', async () => {
    selectSession('MOCK-other-account-session');
    reportDailyStudyCompletion(client, signal());
    expect(log).not.toHaveBeenCalled();
    reportDailyStudyCompletion(client, signal('MOCK-other-account-session'));
    await settleSdk();
    expect(log).toHaveBeenCalledTimes(1);

    client.removeQueries({ queryKey: queryKeys.session });
    reportDailyStudyCompletion(client, signal('MOCK-other-account-session'));
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('has independent ledgers for separate QueryClients', async () => {
    reportDailyStudyCompletion(client, signal());
    await settleSdk();
    const otherClient = new QueryClient();
    otherClient.setQueryData(queryKeys.session, client.getQueryData(queryKeys.session));
    reportDailyStudyCompletion(otherClient, signal());
    await settleSdk();
    reportDailyStudyCompletion(client, signal());
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('does not retry a rejected inflight old-account call without a current-session observation', async () => {
    let reject!: (reason: Error) => void;
    log.mockReturnValueOnce(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
    reportDailyStudyCompletion(client, signal());
    selectSession('MOCK-new-account-session');
    reject(new Error('MOCK SDK reject after account change'));
    await settleSdk();
    reportDailyStudyCompletion(client, signal());
    await settleSdk();
    expect(log).toHaveBeenCalledTimes(1);

    reportDailyStudyCompletion(client, signal('MOCK-new-account-session'));
    await settleSdk();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('bounds memory at 32 entries without evicting inflight calls', async () => {
    const resolvers: (() => void)[] = [];
    log.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    for (let index = 0; index < 32; index++) {
      selectSession(`MOCK-session-${index}`);
      reportDailyStudyCompletion(client, signal(`MOCK-session-${index}`));
    }
    selectSession('MOCK-over-capacity');
    reportDailyStudyCompletion(client, signal('MOCK-over-capacity'));
    expect(log).toHaveBeenCalledTimes(32);

    selectSession('MOCK-session-0');
    reportDailyStudyCompletion(client, signal('MOCK-session-0'));
    expect(log).toHaveBeenCalledTimes(32);
    resolvers[0]!();
    await settleSdk();
    selectSession('MOCK-over-capacity');
    reportDailyStudyCompletion(client, signal('MOCK-over-capacity'));
    expect(log).toHaveBeenCalledTimes(33);
  });

  it('makes the eviction limit explicit: a forgotten success may be sent again', async () => {
    for (let index = 0; index < 33; index++) {
      selectSession(`MOCK-session-${index}`);
      reportDailyStudyCompletion(client, signal(`MOCK-session-${index}`));
      await settleSdk();
    }
    selectSession('MOCK-session-0');
    reportDailyStudyCompletion(client, signal('MOCK-session-0'));
    await settleSdk();
    expect(log).toHaveBeenCalledTimes(34);
  });

  it('makes restart semantics explicit: a new document may resend an SDK-resolved completion', async () => {
    reportDailyStudyCompletion(client, signal());
    await settleSdk();
    reportDailyStudyCompletion(client, signal());
    expect(log).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const newDocument = await import('./completion.ts');
    newDocument.reportDailyStudyCompletion(client, signal());
    await settleSdk();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
