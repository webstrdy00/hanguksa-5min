import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { trackImpression } = vi.hoisted(() => ({ trackImpression: vi.fn() }));
vi.mock('./events.ts', () => ({ trackImpression }));

let scheduleFirstQuestionReady: typeof import('./study-performance.ts').scheduleFirstQuestionReady;
let frames: Map<number, FrameRequestCallback>;

function advanceFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

beforeEach(async () => {
  // A fresh module represents a fresh document; production has no reset API.
  vi.resetModules();
  ({ scheduleFirstQuestionReady } = await import('./study-performance.ts'));
  trackImpression.mockClear();
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(performance, 'now').mockReturnValue(1_250.5);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('first usable question timing', () => {
  it('reports only named numeric durations after a paint opportunity, with no content or identifiers', () => {
    scheduleFirstQuestionReady(200);
    expect(trackImpression).not.toHaveBeenCalled();
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();
    advanceFrame();

    expect(trackImpression).toHaveBeenCalledExactlyOnceWith('first_question_ready', {
      navigation_to_first_question_ready_ms: 1_250.5,
      study_entry_to_first_question_ready_ms: 1_050.5,
    });
  });

  it('suppresses concurrent scheduling and all later mounts in the same document', () => {
    const cleanup = scheduleFirstQuestionReady(200);
    scheduleFirstQuestionReady(300);
    advanceFrame();
    advanceFrame();
    cleanup?.();
    scheduleFirstQuestionReady(500);
    advanceFrame();
    advanceFrame();

    expect(trackImpression).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('cleanup after %i frames does not consume a later usable render', (count) => {
    const cleanup = scheduleFirstQuestionReady(200);
    for (let index = 0; index < count; index++) advanceFrame();
    const staleCallback = [...frames.values()][0]!;
    cleanup?.();
    // A callback already queued by the browser must also honor cleanup.
    staleCallback(0);
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();

    scheduleFirstQuestionReady(300);
    advanceFrame();
    advanceFrame();
    expect(trackImpression).toHaveBeenCalledExactlyOnceWith('first_question_ready', {
      navigation_to_first_question_ready_ms: 1_250.5,
      study_entry_to_first_question_ready_ms: 950.5,
    });
  });

  it.each([NaN, Infinity, -1])('does not emit or consume an invalid entry clock: %s', (entry) => {
    scheduleFirstQuestionReady(entry);
    advanceFrame();
    advanceFrame();
    expect(trackImpression).not.toHaveBeenCalled();

    scheduleFirstQuestionReady(200);
    advanceFrame();
    advanceFrame();
    expect(trackImpression).toHaveBeenCalledTimes(1);
  });

  it.each([NaN, Infinity, -1])(
    'does not emit or consume an invalid navigation clock: %s',
    (now) => {
      vi.mocked(performance.now).mockReturnValue(now);
      scheduleFirstQuestionReady(200);
      advanceFrame();
      advanceFrame();
      expect(trackImpression).not.toHaveBeenCalled();

      vi.mocked(performance.now).mockReturnValue(1_250.5);
      scheduleFirstQuestionReady(200);
      advanceFrame();
      advanceFrame();
      expect(trackImpression).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the screen duration nonnegative if clock readings are reversed', () => {
    vi.mocked(performance.now).mockReturnValue(100);
    scheduleFirstQuestionReady(200);
    advanceFrame();
    advanceFrame();

    expect(trackImpression).toHaveBeenCalledExactlyOnceWith('first_question_ready', {
      navigation_to_first_question_ready_ms: 100,
      study_entry_to_first_question_ready_ms: 0,
    });
  });
});
