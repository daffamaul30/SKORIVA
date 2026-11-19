/**
 * Event REST serializers (T-30).
 *
 * Event responses contain no secrets. Match summaries expose only the minimal
 * viewer display (B-07) and never `state`, `access`, or the event log.
 */

import type { MatchStatus, ResultDecision, ScoreboardView } from '@skoriva/shared';
import type { EventDocumentModel, MatchDocument } from '../../models/index.js';
import { builtInSportRegistry } from '../../sports/builtins.js';
import { composeScoreboardView } from '../../sports/shared/display.js';

export interface EventSummary {
  id: string;
  name: string;
  sport: EventDocumentModel['sport'];
  parentId: string | null;
  description: string | null;
  date: Date | null;
  ownerId: string;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventMatchSummary {
  id: string;
  sport: MatchDocument['sport'];
  teams: MatchDocument['teams'];
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
  context: {
    stageLabel: string | null;
    matchNumber: number | null;
  };
  display: ScoreboardView;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface EventGroup {
  /** `null` is the fallback group; the client renders "Lainnya". */
  label: string | null;
  matches: EventMatchSummary[];
}

export function toEventSummary(event: EventDocumentModel): EventSummary {
  return {
    id: event._id.toString(),
    name: event.name,
    sport: event.sport,
    parentId: event.parentId?.toString() ?? null,
    description: event.description ?? null,
    date: event.date ?? null,
    ownerId: event.ownerId.toString(),
    archived: event.archived,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export function toEventMatchSummary(match: MatchDocument, now = new Date()): EventMatchSummary {
  const engine = builtInSportRegistry.get(match.sport);
  const display = composeScoreboardView(
    match,
    engine.deriveDisplay(match.state.sportState, now),
    now,
  );

  return {
    id: match._id.toString(),
    sport: match.sport,
    teams: match.teams,
    matchStatus: match.matchStatus,
    resultDecision: match.resultDecision,
    context: {
      stageLabel: match.context.stageLabel ?? null,
      matchNumber: match.context.matchNumber ?? null,
    },
    display,
    createdAt: match.createdAt,
    startedAt: match.startedAt ?? null,
    finishedAt: match.finishedAt ?? null,
  };
}

function compareMatches(left: MatchDocument, right: MatchDocument): number {
  const leftNumber = left.context.matchNumber;
  const rightNumber = right.context.matchNumber;

  if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== undefined && rightNumber === undefined) return -1;
  if (leftNumber === undefined && rightNumber !== undefined) return 1;

  return left.createdAt.getTime() - right.createdAt.getTime();
}

/**
 * Group matches by `stageLabel` in first-seen order. Matches without a label
 * form the fallback group (`label: null`) and are always last.
 */
export function toEventGroups(matches: readonly MatchDocument[], now = new Date()): EventGroup[] {
  const sorted = [...matches].sort(compareMatches);
  const labeled = new Map<string, EventMatchSummary[]>();
  const fallback: EventMatchSummary[] = [];

  for (const match of sorted) {
    const summary = toEventMatchSummary(match, now);
    const label = match.context.stageLabel;

    if (label) {
      const group = labeled.get(label);
      if (group) {
        group.push(summary);
      } else {
        labeled.set(label, [summary]);
      }
    } else {
      fallback.push(summary);
    }
  }

  const groups: EventGroup[] = [...labeled.entries()].map(([label, groupMatches]) => ({
    label,
    matches: groupMatches,
  }));

  if (fallback.length > 0) {
    groups.push({ label: null, matches: fallback });
  }

  return groups;
}

export function toEventListResponse(events: readonly EventDocumentModel[]) {
  return { events: events.map(toEventSummary) };
}

export function toEventChildrenResponse(children: readonly EventDocumentModel[]) {
  return { children: children.map(toEventSummary) };
}

export function toEventMatchesResponse(groups: EventGroup[]) {
  return { groups };
}
