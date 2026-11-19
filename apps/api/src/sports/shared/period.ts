/**
 * Core-owned period marker helpers (T-19).
 *
 * Engines never mutate `state.period`; they emit `period.next` as an intent and
 * the core applies the marker transition here. This keeps a single source of
 * truth for period/set position.
 */

import type { MatchConfig, MatchState } from '@skoriva/shared';
import { resetClockForPeriod } from '../../core/clock.js';

export function periodCount(config: MatchConfig): number {
  return config.periods.count;
}

export function periodLabel(config: MatchConfig, index: number): string {
  return config.periods.labels?.[index] ?? `Period ${index + 1}`;
}

function withClockForPeriod(state: MatchState, config: MatchConfig, now: Date): MatchState {
  if (state.clock.mode !== 'timed') return state;

  return {
    ...state,
    clock: resetClockForPeriod(state.clock, now, config.periods.durationMs),
  };
}

export function canAdvancePeriod(state: MatchState, config: MatchConfig): boolean {
  return state.period.index < periodCount(config) - 1;
}

export function advancePeriod(state: MatchState, config: MatchConfig, now: Date): MatchState {
  const nextIndex = Math.min(state.period.index + 1, periodCount(config) - 1);

  return withClockForPeriod(
    {
      ...state,
      period: {
        index: nextIndex,
        label: periodLabel(config, nextIndex),
        status: 'active',
      },
      flags: { ...state.flags, periodComplete: false },
    },
    config,
    now,
  );
}

export function canStepBackPeriodMarker(state: MatchState): boolean {
  return state.period.index > 0;
}

export function stepBackPeriod(state: MatchState, config: MatchConfig, now: Date): MatchState {
  const previousIndex = Math.max(state.period.index - 1, 0);

  return withClockForPeriod(
    {
      ...state,
      period: {
        index: previousIndex,
        label: periodLabel(config, previousIndex),
        status: 'active',
      },
      flags: { ...state.flags, periodComplete: false },
    },
    config,
    now,
  );
}
