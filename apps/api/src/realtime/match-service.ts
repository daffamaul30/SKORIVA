/**
 * Realtime-configured `MatchService` (T-28).
 *
 * Reuses the T-12 pipeline, T-13 lifecycle guard, T-14 event log, T-19 sport
 * reducer, T-15 replay, and T-17 runtime registry. There is no second queue,
 * reducer, registry, or event log.
 */

import { MatchService } from '../core/match.service.js';
import { eventLogBuilder } from '../core/event-log.js';
import { lifecycleGuard } from '../core/lifecycle.js';
import { foldEvents } from '../core/snapshot.js';
import { runtimeRegistry } from '../core/runtime.registry.js';
import { builtInSportRegistry } from '../sports/builtins.js';
import { createSportReducer } from '../sports/shared/reducer.js';
import { createSportReplayFolder } from '../sports/shared/replay.js';

export function createRealtimeMatchService(): MatchService {
  return new MatchService({
    lifecycle: lifecycleGuard,
    reduce: createSportReducer(builtInSportRegistry),
    buildEvents: eventLogBuilder,
    replay: (baseState, events, match) =>
      foldEvents(
        baseState,
        events,
        createSportReplayFolder({
          registry: builtInSportRegistry,
          config: match.config,
          sport: match.sport,
        }),
      ),
    loadMatch: (matchId) => runtimeRegistry.loadMatch(matchId),
    queue: runtimeRegistry.serialQueue,
  });
}
