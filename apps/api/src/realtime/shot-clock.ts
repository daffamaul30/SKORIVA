/**
 * One-time shot-clock expiry transition (T-26/T-28).
 *
 * The ticker triggers this at most once per expiry. The transition runs through
 * the shared per-match queue, appends `shotClock.expired` + `clock.pause`, and
 * persists once. Retries use a deterministic txId and are idempotent.
 */

import { expireShotClock } from '../sports/basketball/engine.js';
import { buildEventLog } from '../core/event-log.js';
import { matchQueue } from '../core/match-queue.js';
import { runtimeRegistry } from '../core/runtime.registry.js';
import type { DispatchAction } from '../core/match.service.js';
import { persistEventsAndState } from '../repositories/match.repo.js';
import type { RealtimeGateway } from './gateway.js';
import { toOperatorPatch, toViewerPatch } from './serializers.js';

export interface ShotClockExpiryDeps {
  gateway: RealtimeGateway;
  now: () => Date;
}

function safeBroadcast(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error(
      '[realtime] shot clock broadcast failed',
      error instanceof Error ? error.message : 'unknown error',
    );
  }
}

export function createShotClockExpiry(
  deps: ShotClockExpiryDeps,
): (matchId: string) => Promise<void> {
  return async (matchId: string): Promise<void> => {
    await matchQueue.run(matchId, async () => {
      const loaded = await runtimeRegistry.loadMatch(matchId);

      if (!loaded || loaded.match.matchStatus !== 'live') return;
      if (loaded.match.sport !== 'basketball') return;

      const now = deps.now();
      const expired = expireShotClock(loaded.match.state, now);
      if (expired.emitted.length === 0) return;

      const action: DispatchAction = {
        type: 'clock.pause',
        payload: {},
        txId: `shot-clock-expired:${loaded.match.state.version}`,
        expectedVersion: loaded.match.state.version,
      };
      const events = buildEventLog({
        match: loaded.match,
        action,
        state: expired.state,
        emitted: expired.emitted,
        maxSeq: loaded.lastSeq,
        now,
        actor: { type: 'system' },
      });
      const state = { ...expired.state, version: loaded.lastSeq + events.length };

      const persisted = await persistEventsAndState({ matchId, events, state });

      if (persisted.status === 'match_not_found') return;

      // Durable events + replay are the self-healing path for a failed state
      // update. Reload so the cache is authoritative before broadcasting.
      const refreshed = await runtimeRegistry.loadMatch(matchId);
      const match = refreshed?.match;
      if (!match) return;

      safeBroadcast(() =>
        deps.gateway.broadcastPatch(matchId, toOperatorPatch(match, now), 'operator'),
      );
      safeBroadcast(() =>
        deps.gateway.broadcastPatch(matchId, toViewerPatch(match, now), 'viewer'),
      );
    });
  };
}
