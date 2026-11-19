/**
 * Local runtime contract for sport engines (T-19).
 *
 * The shared `SportEngine` type is a conceptual, type-only contract. It cannot
 * be implemented directly because:
 * - `deriveDisplay(state)` needs match context to build a full `ScoreboardView`;
 * - `reduce(state, action)` needs the core clock/period/config context.
 *
 * This local contract adds that context and the correction hook required by
 * T-18. `packages/shared` is intentionally not modified.
 */

import type {
  ActionSuggestion,
  ClockState,
  EventType,
  MatchAction,
  MatchConfig,
  MatchEventPayload,
  MatchState,
  PeriodState,
  ReduceResult,
  ResultCorrection,
  ScoreboardBadmintonServe,
  ScoreboardScore,
  ScoreboardSetScore,
  ScoreboardShotClock,
  Sport,
  SportState,
  ValidationResult,
} from '@skoriva/shared';

export interface SportReduceContext {
  clock: ClockState;
  period: PeriodState;
  config: MatchConfig;
  now: Date;
}

/** Sport-owned part of the viewer display; the serializer adds teams/status. */
export interface SportDisplay {
  score: ScoreboardScore;
  sets?: ScoreboardSetScore[];
  shotClock?: ScoreboardShotClock;
  badmintonServe?: ScoreboardBadmintonServe;
  period?: { index: number; label: string; total?: number };
}

/** Audit shape for `result.correct` before/after values. */
export interface CorrectionAudit {
  score: ScoreboardScore;
  sets?: ScoreboardSetScore[];
}

export type CorrectionResult =
  | {
      ok: true;
      sportState: SportState;
      before: CorrectionAudit;
      after: CorrectionAudit;
    }
  | { ok: false; code: string; message: string };

export interface SportEngineRuntime {
  readonly sport: Sport;

  /** Default configuration for this sport. */
  defaults(): MatchConfig;

  /** Initial sport state for a fresh match. */
  init(config: MatchConfig): SportState;

  /** Validate a match configuration against this sport's rules. */
  validateConfig(config: MatchConfig): ValidationResult;

  /** Validate an action without mutating state. */
  validate(state: SportState, action: MatchAction, context: SportReduceContext): ValidationResult;

  /** Pure reducer; must not perform I/O. */
  reduce(
    state: SportState,
    action: MatchAction,
    context: SportReduceContext,
  ): ReduceResult<SportState>;

  /** Sport-owned display fields. `now` is used for derived clocks. */
  deriveDisplay(state: SportState, now?: Date): SportDisplay;

  /** Contextual operator suggestions. */
  suggestions(state: SportState): readonly ActionSuggestion[];

  /** Whether `period.prev` is allowed (Basketball/Futsal only). */
  canStepBackPeriod(state: MatchState): boolean;

  /** Sport-specific result correction (B-10). */
  correct(state: MatchState, correction: ResultCorrection, config: MatchConfig): CorrectionResult;

  /**
   * Optional hook for sport-owned domain events that are not `MatchAction`s
   * (for example Basketball `shotClock.expired`). Used during replay.
   */
  applyDomainEvent?(state: MatchState, event: SportDomainEvent): MatchState;
}

export interface SportDomainEvent {
  type: EventType;
  payload: MatchEventPayload;
  serverTs: Date;
}

export function validationOk(): ValidationResult {
  return { ok: true };
}

export function validationFail(code: string, message: string): ValidationResult {
  return { ok: false, code, message };
}

export function reduceFail(code: string, message: string): ReduceResult<SportState> {
  return { ok: false, code, message };
}
