/**
 * Match change publisher hook (T-29 integration for Batch 4).
 *
 * The REST module defines the interface; the realtime module implements it and
 * the application boundary wires them. This avoids a circular dependency between
 * REST and Socket.IO.
 */

import type { MatchDocument } from '../../models/index.js';

export interface MatchChangePublisher {
  /** Lifecycle status changed (start/finish/cancel/reopen/save/discard/restore). */
  publishStatus(match: MatchDocument): void;
  /** Match state/context changed without a lifecycle status transition. */
  publishPatch(match: MatchDocument): void;
}

let currentPublisher: MatchChangePublisher | undefined;

export function setMatchChangePublisher(publisher: MatchChangePublisher | undefined): void {
  currentPublisher = publisher;
}

function safePublish(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error(
      '[match] publisher failed',
      error instanceof Error ? error.message : 'unknown error',
    );
  }
}

export function publishMatchStatus(match: MatchDocument): void {
  safePublish(() => currentPublisher?.publishStatus(match));
}

export function publishMatchPatch(match: MatchDocument): void {
  safePublish(() => currentPublisher?.publishPatch(match));
}
