/**
 * Compose a sport-owned display with match context into the viewer contract
 * (T-19). The serializer in T-25 will use this; engines stay free of match
 * document concerns.
 */

import type { MatchDocument } from '../../models/index.js';
import type { ScoreboardView } from '@skoriva/shared';
import { deriveRemainingMs } from '../../core/clock.js';
import type { SportDisplay } from './types.js';

export function composeScoreboardView(
  match: MatchDocument,
  display: SportDisplay,
  now = new Date(),
): ScoreboardView {
  const view: ScoreboardView = {
    matchStatus: match.matchStatus,
    resultDecision: match.resultDecision,
    teams: {
      home: {
        name: match.teams.home.name,
        abbr: match.teams.home.abbr,
        color: match.teams.home.color,
      },
      away: {
        name: match.teams.away.name,
        abbr: match.teams.away.abbr,
        color: match.teams.away.color,
      },
    },
    score: display.score,
    period: display.period ?? {
      index: match.state.period.index,
      label: match.state.period.label,
      total: match.config.periods.count,
    },
  };

  if (match.state.clock.mode === 'timed') {
    view.clock = {
      remainingMs: deriveRemainingMs(match.state.clock, now),
      isRunning: match.state.clock.isRunning,
    };
  }

  if (display.sets) view.sets = display.sets;
  if (display.shotClock) view.shotClock = display.shotClock;
  if (display.badmintonServe) view.badmintonServe = display.badmintonServe;

  return view;
}
