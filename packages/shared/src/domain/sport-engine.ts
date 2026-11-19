/**
 * Sport engine contract (Task T-02, Tech Spec §1.3).
 *
 * This is a **type-only interface**. No reducer implementation and no runtime
 * registry live in `@skoriva/shared`:
 * - engines are implemented in `apps/api/src/sports/<sport>/` (T-20…T-23);
 * - the registry is created in `apps/api/src/sports/registry.ts` (T-19).
 *
 * Architectural separation is mandatory (Tech Spec §1.5):
 * core never imports from `sports/`, and `sports/*` never imports repositories
 * or the realtime gateway.
 */

import type { MatchAction } from './action.js';
import type { ScoreboardView } from './display.js';
import type { SportConfigFor } from './match-config.js';
import type { MatchState, SportState } from './match.js';
import type { Sport } from './sport.js';

/** Result of validating an action against a sport state. */
export type ValidationResult =
  | { ok: true }
  | {
      ok: false;
      /** Stable machine code, e.g. `PERIOD_PREV_HAS_ACTION`. */
      code: string;
      /** Human-readable Indonesian message for the operator UI. */
      message: string;
    };

/** Successful reduction: new state plus the events it produced. */
export interface ReduceSuccess<TState extends SportState> {
  ok: true;
  state: TState;
  /** Event types emitted by this action, in order (may be more than one). */
  emitted: readonly MatchAction['type'][];
}

/** Failed reduction; failed validation or sport rules rejected the action. */
export interface ReduceFailure {
  ok: false;
  code: string;
  message: string;
}

export type ReduceResult<TState extends SportState> = ReduceSuccess<TState> | ReduceFailure;

/**
 * Contextual action suggestion for the operator panel.
 *
 * Suggestions are hints only; the engine still validates whatever is sent.
 * Reasoning is intentionally abstract so that no sport rules are duplicated
 * in the shared package.
 */
export interface ActionSuggestion {
  /** Action type the operator may want to trigger next. */
  type: MatchAction['type'];
  /** Human-readable Indonesian hint. */
  hint: string;
}

/**
 * Public contract every sport engine implements (Tech Spec §1.3, §1.5).
 *
 * @typeParam TConfig - sport-specific configuration type
 * @typeParam TState  - opaque sport state stored in `matches.state.sportState`
 */
export interface SportEngine<
  S extends Sport,
  TConfig extends SportConfigFor<S> = SportConfigFor<S>,
  TState extends SportState = SportState,
> {
  readonly sport: S;

  /** `true` only for Basketball and Futsal (B-01). */
  readonly supportsStepBackPeriod: boolean;

  /** Default configuration for this sport (PRD FR-03). */
  defaults(): TConfig;

  /** Create the initial sport state for a fresh match (v0). */
  init(config: TConfig): TState;

  /** Validate an action against the current state without mutating it. */
  validate(state: Readonly<TState>, action: MatchAction): ValidationResult;

  /** Pure reducer; must not perform I/O (Tech Spec §1.3). */
  reduce(state: Readonly<TState>, action: MatchAction): ReduceResult<TState>;

  /** Derive the minimal viewer display (B-07). */
  deriveDisplay(state: Readonly<TState>): ScoreboardView;

  /** Contextual suggestions for the operator panel. */
  suggestions(state: Readonly<TState>): readonly ActionSuggestion[];

  /**
   * Whether `period.prev` is currently permitted.
   *
   * Marker-only with guard (B-01): false when the active period already has
   * scoring/sport actions. Volleyball and Badminton always return false.
   */
  canStepBackPeriod(state: Readonly<MatchState>): boolean;
}
