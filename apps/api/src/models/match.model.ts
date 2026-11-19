/**
 * `matches` schema (T-07, Tech Spec §2.3 / §2.5).
 *
 * No timeout config, no tournament context, no group label.
 * `state.clock.lastDurableRemainingMs` and `lastDurableAt` are the durable
 * recovery checkpoint (B-11 / FIX 3).
 */

import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose';
import type {
  MatchAccess,
  MatchConfig,
  MatchOwner,
  MatchState,
  MatchStatus,
  MatchTeams,
  ResultDecision,
  Sport,
  SportState,
} from '@skoriva/shared';
import {
  GAME_CLOCK_MODES,
  MATCH_STATUSES,
  OWNER_TYPES,
  PERIOD_STATUSES,
  RESULT_DECISIONS,
  SPORTS,
} from './enums.js';

const teamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    abbr: { type: String, trim: true, maxlength: 8 },
    color: { type: String, trim: true, maxlength: 32 },
  },
  { _id: false },
);

const teamsSchema = new mongoose.Schema(
  {
    home: { type: teamSchema, required: true },
    away: { type: teamSchema, required: true },
  },
  { _id: false },
);

const periodConfigSchema = new mongoose.Schema(
  {
    count: { type: Number, required: true, min: 1 },
    durationMs: { type: Number, required: true, min: 0 },
    labels: [{ type: String, trim: true, maxlength: 40 }],
  },
  { _id: false },
);

const gameClockSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: [...GAME_CLOCK_MODES], required: true },
    allowStop: {
      type: Boolean,
      required: function (this: { mode?: string }) {
        return this.mode === 'timed';
      },
    },
  },
  { _id: false },
);

const shotClockSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, required: true },
    durationMs: {
      type: Number,
      min: 1,
      required: function (this: { enabled?: boolean }) {
        return this.enabled === true;
      },
    },
  },
  { _id: false },
);

const scoringSchema = new mongoose.Schema(
  {
    pointsPerGoal: {
      type: [Number],
      required: true,
      validate: {
        validator: (values: number[]) => values.length > 0 && values.every((value) => value > 0),
        message: 'pointsPerGoal must contain positive values.',
      },
    },
  },
  { _id: false },
);

const volleyballConfigSchema = new mongoose.Schema(
  {
    bestOf: { type: Number, enum: [3, 5], required: true },
    pointTarget: { type: Number, required: true, min: 1 },
    tiebreakTarget: { type: Number, required: true, min: 1 },
    winByDiff: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const badmintonConfigSchema = new mongoose.Schema(
  {
    bestOf: { type: Number, enum: [3], required: true },
    pointTarget: { type: Number, required: true, min: 1 },
    winByDiff: { type: Number, required: true, min: 1 },
    pointCap: { type: Number, required: true, min: 1 },
    intervalAt: { type: Number, required: true, min: 1 },
    intervalDurationMs: { type: Number, required: true, min: 1 },
    changeEndsAtDecidingSet: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const matchConfigSchema = new mongoose.Schema(
  {
    periods: { type: periodConfigSchema, required: true },
    gameClock: { type: gameClockSchema, required: true },
    shotClock: { type: shotClockSchema, required: true },
    scoring: { type: scoringSchema, required: true },
    volleyball: { type: volleyballConfigSchema },
    badminton: { type: badmintonConfigSchema },
  },
  { _id: false },
);

const matchContextSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
    stageLabel: { type: String, trim: true, maxlength: 80 },
    matchNumber: { type: Number, min: 1 },
  },
  { _id: false },
);

const periodStateSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true, min: 0 },
    label: { type: String, required: true, trim: true },
    status: { type: String, enum: [...PERIOD_STATUSES], default: 'pending' },
  },
  { _id: false },
);

const clockStateSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: [...GAME_CLOCK_MODES], required: true },
    remainingMs: { type: Number, required: true, min: 0, default: 0 },
    isRunning: { type: Boolean, required: true, default: false },
    anchorServerTs: { type: Number, required: true, default: 0 },
    lastDurableRemainingMs: { type: Number, required: true, min: 0, default: 0 },
    lastDurableAt: { type: Date, required: true },
    recoveryPending: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const matchFlagsSchema = new mongoose.Schema(
  {
    clockExpired: { type: Boolean, required: true, default: false },
    periodComplete: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const matchStateSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, min: 0, default: 0 },
    period: { type: periodStateSchema, required: true },
    clock: { type: clockStateSchema, required: true },
    sportState: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    flags: { type: matchFlagsSchema, required: true },
  },
  { _id: false },
);

const operatorSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true },
    credentialHash: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { _id: false },
);

const handoverCodeSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true },
    sourceSessionId: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { _id: false },
);

const matchAccessSchema = new mongoose.Schema(
  {
    controlTokenHash: { type: String, required: true },
    /** Hash only; the plaintext view code is never stored (B-08). */
    viewCodeHash: { type: String, required: true },
    viewCodeIssuedAt: { type: Date, required: true },
    tokenIssuedAt: { type: Date, required: true },
    revokedTokenHashes: { type: [String], default: () => [] },
    revokedViewCodeHashes: { type: [String], default: () => [] },
    /** R-01: operator session proof; hash only. */
    operatorSession: { type: operatorSessionSchema },
    /** R-02: one-time handover code; hash only. */
    handoverCode: { type: handoverCodeSchema },
  },
  { _id: false },
);

const matchOwnerSchema = new mongoose.Schema(
  {
    type: { type: String, enum: [...OWNER_TYPES], required: true },
    id: { type: String, required: true, trim: true },
  },
  { _id: false },
);

export interface MatchDocument {
  _id: Types.ObjectId;
  sport: Sport;
  teams: MatchTeams;
  config: MatchConfig;
  context: {
    eventId?: Types.ObjectId;
    stageLabel?: string;
    matchNumber?: number;
  };
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
  state: MatchState<SportState>;
  access: MatchAccess;
  activeOperatorId?: string;
  operatorGraceUntil?: Date;
  owner: MatchOwner;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const matchSchema = new mongoose.Schema<MatchDocument>(
  {
    sport: { type: String, enum: [...SPORTS], required: true },
    teams: { type: teamsSchema, required: true },
    config: { type: matchConfigSchema, required: true },
    context: { type: matchContextSchema, default: () => ({}) },
    matchStatus: { type: String, enum: [...MATCH_STATUSES], default: 'ready' },
    resultDecision: { type: String, enum: [...RESULT_DECISIONS], default: 'undecided' },
    state: { type: matchStateSchema, required: true },
    access: { type: matchAccessSchema, required: true },
    activeOperatorId: { type: String },
    operatorGraceUntil: { type: Date },
    owner: { type: matchOwnerSchema, required: true },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  {
    collection: 'matches',
    versionKey: false,
    timestamps: true,
    minimize: false,
  },
);

matchSchema.index({ 'context.eventId': 1, matchStatus: 1 });
matchSchema.index({
  'context.eventId': 1,
  'context.stageLabel': 1,
  'context.matchNumber': 1,
});
matchSchema.index({ resultDecision: 1, finishedAt: -1 });
matchSchema.index({ 'access.viewCodeHash': 1 }, { unique: true });
matchSchema.index({ 'owner.type': 1, 'owner.id': 1 });

export type MatchHydratedDocument = HydratedDocument<MatchDocument>;

export const MatchModel: Model<MatchDocument> =
  (mongoose.models.Match as Model<MatchDocument> | undefined) ??
  mongoose.model<MatchDocument>('Match', matchSchema);
