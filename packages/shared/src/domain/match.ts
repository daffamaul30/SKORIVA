/**
 * Match lifecycle and match document types (Tech Spec §1.4, §2.3 `matches`).
 */

import type { MatchConfig } from './match-config.js';
import type { Sport } from './sport.js';
import type { MatchTeams } from './team.js';

/** Match status axis (PRD §3A / Tech Spec §1.4). */
export const MATCH_STATUSES = ['ready', 'live', 'finished', 'cancelled'] as const;

export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** Result decision axis; only meaningful while `matchStatus === 'finished'`. */
export const RESULT_DECISIONS = ['undecided', 'saved', 'discarded'] as const;

export type ResultDecision = (typeof RESULT_DECISIONS)[number];

/** Match ownership is separate from operator access (PRD B-04). */
export interface MatchOwner {
  type: 'device' | 'account';
  id: string;
}

/** Event attachment for a match (PRD FR-04, Tech Spec §2.3 `matches.context`). */
export interface MatchContext {
  eventId?: string;
  /** Free-text stage label (BR-17; no label standardisation in MVP). Limit: 80 characters. */
  stageLabel?: string;
  matchNumber?: number;
}

/** Clock anchor state persisted with the match document (Tech Spec §2.3, §4.2). */
export interface ClockState {
  mode: 'timed' | 'none';
  /** Volatile/derived remaining time; never the recovery source (B-11). */
  remainingMs: number;
  isRunning: boolean;
  /** Server timestamp of the running-clock anchor. */
  anchorServerTs: number;
  /** Last durable checkpoint persisted to the database. */
  lastDurableRemainingMs: number;
  lastDurableAt: Date;
  /** True after a restart: clock is frozen until `clock.confirm` (B-11). */
  recoveryPending: boolean;
}

export const PERIOD_STATUSES = ['pending', 'active', 'complete'] as const;

export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export interface PeriodState {
  index: number;
  label: string;
  status: PeriodStatus;
}

/** Opaque container owned by the sport engine (Tech Spec §2.3, BR-13). */
export type SportState = Readonly<Record<string, unknown>>;

export interface MatchFlags {
  clockExpired: boolean;
  periodComplete: boolean;
}

/** Materialised operational state, versioned by the event sequence (Tech Spec §4.4). */
export interface MatchState<TState extends SportState = SportState> {
  version: number;
  period: PeriodState;
  clock: ClockState;
  sportState: TState;
  flags: MatchFlags;
}

/** Operator session proof for REST lifecycle calls (R-01). Hash-only storage. */
export interface OperatorSession {
  sessionId: string;
  credentialHash: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

/** One-time handover code (R-02). Hash-only storage. */
export interface OperatorHandoverCode {
  codeHash: string;
  sourceSessionId: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt?: Date;
}

/** Access material for a match (Tech Spec §2.3 `matches.access`, R-01…R-04). */
export interface MatchAccess {
  controlTokenHash: string;
  /** Hash of the viewer code; plaintext is never stored (B-08). */
  viewCodeHash: string;
  viewCodeIssuedAt: Date;
  tokenIssuedAt: Date;
  revokedTokenHashes: string[];
  /** Rotated-away viewer code hashes (R-04). */
  revokedViewCodeHashes: string[];
  operatorSession?: OperatorSession;
  handoverCode?: OperatorHandoverCode;
}

/** Match aggregate document (Tech Spec §2.3 `matches`). */
export interface MatchAggregate<TState extends SportState = SportState> {
  id: string;
  sport: Sport;
  teams: MatchTeams;
  config: MatchConfig;
  context: MatchContext;
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
  state: MatchState<TState>;
  access: MatchAccess;
  activeOperatorId?: string;
  /** Server-side grace window after a disconnect (B-09). */
  operatorGraceUntil?: Date;
  owner: MatchOwner;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}
