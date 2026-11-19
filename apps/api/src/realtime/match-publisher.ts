/**
 * Realtime implementation of the Match REST change publisher (Batch 4).
 *
 * Broadcast failures are logged and never roll back the database commit. Clients
 * that miss a patch recover through `match:join` and its authoritative snapshot.
 */

import type { MatchDocument } from '../models/index.js';
import type { MatchChangePublisher } from '../modules/match/match.publisher.js';
import type { RealtimeGateway } from './gateway.js';
import { toMatchStatusPayload, toOperatorPatch, toViewerPatch } from './serializers.js';

function safeBroadcast(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error(
      '[realtime] publisher broadcast failed',
      error instanceof Error ? error.message : 'unknown error',
    );
  }
}

export function createMatchChangePublisher(gateway: RealtimeGateway): MatchChangePublisher {
  return {
    publishStatus(match: MatchDocument): void {
      const matchId = match._id.toString();
      const now = new Date();

      safeBroadcast(() => gateway.broadcastStatus(matchId, toMatchStatusPayload(match)));
      safeBroadcast(() => gateway.broadcastPatch(matchId, toOperatorPatch(match, now), 'operator'));
      safeBroadcast(() => gateway.broadcastPatch(matchId, toViewerPatch(match, now), 'viewer'));
    },

    publishPatch(match: MatchDocument): void {
      const matchId = match._id.toString();
      const now = new Date();

      safeBroadcast(() => gateway.broadcastPatch(matchId, toOperatorPatch(match, now), 'operator'));
      safeBroadcast(() => gateway.broadcastPatch(matchId, toViewerPatch(match, now), 'viewer'));
    },
  };
}
