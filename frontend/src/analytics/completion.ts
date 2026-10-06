import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/hooks.ts';
import type { SessionResponse } from '../api/types.ts';
import { trackComplete } from './events.ts';

interface CompletionSignal {
  sessionId: string;
  score: number;
  validCount: number;
  streakDays?: number;
}

interface Delivery {
  status: 'pending' | 'inflight' | 'succeeded';
  attempts: number;
  params: Record<string, number>;
}

const MAX_SESSIONS = 32;
const MAX_ATTEMPTS = 3;
const deliveries = new WeakMap<QueryClient, Map<string, Delivery>>();

/**
 * Document-only best effort: retry a rejected SDK call on the next authoritative
 * completion observation, at most three attempts per retained session. No timers,
 * storage, identity keys or backend outbox. Inflight/succeeded calls are deduplicated.
 *
 * Session IDs stay only in this bounded memory map, never in event params. A fresh
 * document (or eviction after 32 sessions) forgets success and may send again; SDK
 * resolve is not remote receipt, and a rejected call may already have been received.
 * Different QueryClients have independent ledgers. Within one client, a removed or
 * replaced current session rejects late signals; authentication/SDK identity changes
 * without clearing or replacing query data cannot be detected here. Already-issued
 * SDK calls cannot be retracted on an account switch.
 */
export function reportDailyStudyCompletion(client: QueryClient, signal: CompletionSignal): void {
  if (client.getQueryData<SessionResponse>(queryKeys.session)?.session.id !== signal.sessionId) {
    return;
  }

  // Whitelist aggregates, even if a caller accidentally passes a larger API object.
  const params: Record<string, number> = {
    score: signal.score,
    valid_count: signal.validCount,
  };
  if (signal.streakDays != null) params.streak_days = signal.streakDays;

  let sessions = deliveries.get(client);
  if (sessions == null) {
    sessions = new Map();
    deliveries.set(client, sessions);
  }

  let delivery = sessions.get(signal.sessionId);
  if (delivery == null) {
    if (sessions.size >= MAX_SESSIONS) {
      // Never evict an unresolved SDK call: revisiting it would start a duplicate.
      const evictable = [...sessions].find(([, entry]) => entry.status !== 'inflight');
      if (evictable == null) return;
      sessions.delete(evictable[0]);
    }
    delivery = { status: 'pending', attempts: 0, params };
    sessions.set(signal.sessionId, delivery);
  } else {
    delivery.params = { ...delivery.params, ...params };
  }

  if (delivery.status !== 'pending' || delivery.attempts >= MAX_ATTEMPTS) return;
  delivery.status = 'inflight';
  delivery.attempts++;
  const attempted = delivery;
  void trackComplete('daily_study', attempted.params).then((succeeded) => {
    attempted.status = succeeded ? 'succeeded' : 'pending';
  });
}
