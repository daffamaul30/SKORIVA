/**
 * Event wire types (T-31.4).
 *
 * Source of truth: `apps/api/src/modules/event/event.serializers.ts`
 * (`EventSummary`, `EventMatchSummary`, `EventGroup`).
 *
 * Events are account-owned; `ownerId` is derived from the authenticated account
 * and never sent by the client.
 */

import type { MatchStatus, ResultDecision, ScoreboardView, Sport } from '@skoriva/shared';
import type { MatchTeams } from '@skoriva/shared';

/** `toEventSummary` — nullable fields are `null`, not absent. */
export interface EventSummary {
  id: string;
  name: string;
  sport: Sport;
  parentId: string | null;
  description: string | null;
  date: string | null;
  ownerId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/events` → `{ events: EventSummary[] }`. */
export interface EventListResponse {
  events: EventSummary[];
}

/** `GET /api/events/:id/children` → `{ children: EventSummary[] }`. */
export interface EventChildrenResponse {
  children: EventSummary[];
}

/** `toEventMatchSummary` — display is only the minimal viewer payload (B-07). */
export interface EventMatchSummary {
  id: string;
  sport: Sport;
  teams: MatchTeams;
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
  context: {
    stageLabel: string | null;
    matchNumber: number | null;
  };
  display: ScoreboardView;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** `label: null` is rendered as "Lainnya" and is always the last group. */
export interface EventGroup {
  label: string | null;
  matches: EventMatchSummary[];
}

/** `GET /api/events/:id/matches` → `{ groups }`. */
export interface EventMatchesResponse {
  groups: EventGroup[];
}

/** `createEventSchema` body; `ownerId`/`archived` are never accepted. */
export interface CreateEventInput {
  name: string;
  sport: Sport;
  parentId?: string;
  description?: string;
  date?: string;
}

/** `updateEventSchema` body: at least one field must be present. */
export interface UpdateEventInput {
  name?: string;
  description?: string;
  date?: string;
}
