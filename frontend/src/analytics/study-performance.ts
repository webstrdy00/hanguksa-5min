import { trackImpression } from './events.ts';

// Module state lasts for this document, not a StudyScreen mount or a study session.
let firstQuestionReadyReported = false;

/**
 * Call only for a rendered, usable unanswered question. Two animation frames allow
 * a browser paint opportunity; this is not a guarantee of pixels reaching a device.
 * The clock starts at browser-document navigation, not native app cold launch.
 * Navigation time includes SDK bootstrap, onboarding and user dwell, not just server startup.
 */
export function scheduleFirstQuestionReady(studyEntryAtMs: number): (() => void) | undefined {
  if (firstQuestionReadyReported || !Number.isFinite(studyEntryAtMs) || studyEntryAtMs < 0) {
    return;
  }

  let cancelled = false;
  let frame = requestAnimationFrame(() => {
    if (cancelled || firstQuestionReadyReported) return;

    frame = requestAnimationFrame(() => {
      if (cancelled || firstQuestionReadyReported) return;

      const navigationToQuestionReadyMs = performance.now();
      if (!Number.isFinite(navigationToQuestionReadyMs) || navigationToQuestionReadyMs < 0) {
        return;
      }

      firstQuestionReadyReported = true;
      trackImpression('first_question_ready', {
        navigation_to_first_question_ready_ms: navigationToQuestionReadyMs,
        study_entry_to_first_question_ready_ms: Math.max(
          0,
          navigationToQuestionReadyMs - studyEntryAtMs,
        ),
      });
    });
  });

  // StrictMode cleanup or leaving the usable question before paint must not consume the event.
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}
