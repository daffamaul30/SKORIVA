/**
 * In-memory match runtime registry (T-17, Tech Spec §5.1, §4.1).
 *
 * Responsibilities:
 * - hydrate a cold match from MongoDB and replay stale snapshots;
 * - keep a process-local runtime entry for live/finished matches;
 * - serialize all actions for one match through the same queue created in T-12;
 * - evict idle entries without deleting any database data.
 *
 * Single-instance only. Multi-instance/Redis coordination is explicitly out of
 * scope for the MVP.
 */

import type { MatchState } from '@skoriva/shared';
import type { MatchDocument, MatchEventDocument } from '../models/index.js';
import { loadMatchWithEvents, replayMatchState } from '../repositories/match.repo.js';
import type { LoadedMatchWithEvents, ReplayMatchStateResult } from '../repositories/match.repo.js';
import { createReplayFn } from './snapshot.js';
import type { EventFolder } from './snapshot.js';
import { matchQueue } from './match-queue.js';
import type { MatchQueue, SerialQueue } from './match-queue.js';

export const DEFAULT_RUNTIME_IDLE_TTL_MS = 5 * 60_000;

export interface MatchRuntime {
  matchId: string;
  match: MatchDocument;
  state: MatchState;
  events: MatchEventDocument[];
  /** Last sequence across all events, including meta events. */
  maxSeq: number;
  /** Last sequence of a state-affecting event (meta events excluded). */
  lastStateAffectingSeq: number;
  lastAccessAt: Date;
}

export type RuntimeRegistryErrorCode = 'MATCH_NOT_FOUND' | 'REPLAY_REQUIRED';

export class RuntimeRegistryError extends Error {
  constructor(
    readonly code: RuntimeRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeRegistryError';
  }
}

export interface RuntimeRegistryDeps {
  loadMatch: (matchId: string) => Promise<LoadedMatchWithEvents | null>;
  replayMatch: (
    matchId: string,
    replay: (baseState: MatchState, events: readonly MatchEventDocument[]) => MatchState,
  ) => Promise<ReplayMatchStateResult>;
  queue: MatchQueue;
  /** Folder used to replay a stale snapshot. Required when replay is needed. */
  replay?: EventFolder;
  now: () => Date;
  idleTtlMs: number;
}

function defaultDeps(): RuntimeRegistryDeps {
  return {
    loadMatch: loadMatchWithEvents,
    replayMatch: replayMatchState,
    queue: matchQueue,
    now: () => new Date(),
    idleTtlMs: DEFAULT_RUNTIME_IDLE_TTL_MS,
  };
}

export class MatchRuntimeRegistry {
  private readonly deps: RuntimeRegistryDeps;
  private readonly runtimes = new Map<string, MatchRuntime>();

  constructor(overrides: Partial<RuntimeRegistryDeps> = {}) {
    this.deps = { ...defaultDeps(), ...overrides };
  }

  get size(): number {
    return this.runtimes.size;
  }

  has(matchId: string): boolean {
    return this.runtimes.has(matchId);
  }

  /** Cached runtime without touching MongoDB. */
  peek(matchId: string): MatchRuntime | undefined {
    return this.runtimes.get(matchId);
  }

  /** Snapshot of all cached runtimes; used by the 1 Hz ticker. */
  listRuntimes(): MatchRuntime[] {
    return [...this.runtimes.values()];
  }

  /**
   * Load and hydrate a match. A stale snapshot is replayed through the injected
   * folder and persisted by the repository before the runtime is cached.
   */
  async loadMatch(matchId: string): Promise<LoadedMatchWithEvents | null> {
    const loaded = await this.deps.loadMatch(matchId);

    if (!loaded) {
      this.runtimes.delete(matchId);
      return null;
    }

    let current = loaded;

    if (loaded.needsReplay) {
      if (!this.deps.replay) {
        throw new RuntimeRegistryError(
          'REPLAY_REQUIRED',
          'A replay folder is required to hydrate this match.',
        );
      }

      const replayed = await this.deps.replayMatch(matchId, createReplayFn(this.deps.replay));

      if (replayed.status === 'match_not_found') {
        this.runtimes.delete(matchId);
        return null;
      }

      // `state_conflict` means another writer won; do not loop. Cache the
      // current view and let the caller observe `needsReplay`; the next
      // hydration will retry.
      const reloaded = await this.deps.loadMatch(matchId);

      if (!reloaded) {
        this.runtimes.delete(matchId);
        return null;
      }

      current = reloaded;
    }

    const runtime = this.cache(matchId, current);
    return this.toLoaded(runtime);
  }

  /**
   * Run a task for one match with the shared serial queue. A cold match is
   * hydrated before the task runs, so the task always sees a warm runtime.
   */
  async runExclusive<T>(matchId: string, task: (runtime: MatchRuntime) => Promise<T>): Promise<T> {
    return this.deps.queue.run(matchId, async () => {
      const loaded = await this.loadMatch(matchId);

      if (!loaded) {
        throw new RuntimeRegistryError('MATCH_NOT_FOUND', 'Match not found.');
      }

      const runtime = this.runtimes.get(matchId)!;

      const result = await task(runtime);

      // The task may have written events/state; refresh the cached view.
      await this.refresh(matchId);
      return result;
    });
  }

  /** Queue-compatible adapter for T-12's `MatchService`. */
  get serialQueue(): SerialQueue {
    return {
      run: (matchId, task) =>
        this.deps.queue.run(matchId, async () => {
          await this.loadMatch(matchId);

          try {
            return await task();
          } finally {
            await this.refresh(matchId);
          }
        }),
    };
  }

  /** Remove one runtime entry; database data is untouched. */
  evict(matchId: string): boolean {
    return this.runtimes.delete(matchId);
  }

  /** Remove runtimes idle for longer than `idleTtlMs`; database data is untouched. */
  evictIdle(now = this.deps.now()): number {
    const cutoff = now.getTime() - this.deps.idleTtlMs;
    let removed = 0;

    for (const [matchId, runtime] of this.runtimes) {
      if (runtime.lastAccessAt.getTime() <= cutoff) {
        this.runtimes.delete(matchId);
        removed += 1;
      }
    }

    return removed;
  }

  /** Drop all runtime entries; database data is untouched. */
  clear(): void {
    this.runtimes.clear();
  }

  private async refresh(matchId: string): Promise<void> {
    const loaded = await this.deps.loadMatch(matchId);

    if (!loaded) {
      this.runtimes.delete(matchId);
      return;
    }

    // Do not replay inside refresh: the task already persisted its result.
    this.cache(matchId, loaded);
  }

  private cache(matchId: string, loaded: LoadedMatchWithEvents): MatchRuntime {
    const runtime: MatchRuntime = {
      matchId,
      match: loaded.match,
      state: loaded.match.state,
      events: loaded.events,
      maxSeq: loaded.maxSeq,
      lastStateAffectingSeq: loaded.lastStateAffectingSeq,
      lastAccessAt: this.deps.now(),
    };

    this.runtimes.set(matchId, runtime);
    return runtime;
  }

  private toLoaded(runtime: MatchRuntime): LoadedMatchWithEvents {
    return {
      match: { ...runtime.match, state: runtime.state },
      events: runtime.events,
      lastSeq: runtime.maxSeq,
      lastStateAffectingSeq: runtime.lastStateAffectingSeq,
      maxSeq: runtime.maxSeq,
      needsReplay: runtime.state.version < runtime.lastStateAffectingSeq,
    };
  }
}

/** Default singleton for the API process. */
export const runtimeRegistry = new MatchRuntimeRegistry();
