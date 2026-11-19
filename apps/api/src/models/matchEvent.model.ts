/**
 * `matchEvents` append-only schema (T-07, Tech Spec §2.3 / §2.5).
 *
 * No update/delete helpers live here; append-only behavior is enforced by the
 * repository/event-log layer in later tasks (BR-09).
 */

import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose';
import type { EventActor, EventType, MatchEventPayload } from '@skoriva/shared';
import { ACTOR_TYPES, EVENT_TYPES } from './enums.js';

const actorSchema = new mongoose.Schema(
  {
    type: { type: String, enum: [...ACTOR_TYPES], required: true },
    id: { type: String, trim: true },
  },
  { _id: false },
);

export interface MatchEventDocument {
  _id: Types.ObjectId;
  matchId: Types.ObjectId;
  seq: number;
  txId: string;
  type: EventType;
  payload: MatchEventPayload;
  actor: EventActor;
  serverTs: Date;
  appliedAt: Date;
}

const matchEventSchema = new mongoose.Schema<MatchEventDocument>(
  {
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
    seq: { type: Number, required: true, min: 1 },
    txId: { type: String, required: true, trim: true, maxlength: 128 },
    type: { type: String, enum: [...EVENT_TYPES], required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    actor: { type: actorSchema, required: true },
    serverTs: { type: Date, required: true },
    appliedAt: { type: Date, required: true },
  },
  {
    collection: 'matchEvents',
    versionKey: false,
  },
);

matchEventSchema.index({ matchId: 1, seq: 1 }, { unique: true });
matchEventSchema.index({ matchId: 1, txId: 1 }, { unique: true });

export type MatchEventHydratedDocument = HydratedDocument<MatchEventDocument>;

export const MatchEventModel: Model<MatchEventDocument> =
  (mongoose.models.MatchEvent as Model<MatchEventDocument> | undefined) ??
  mongoose.model<MatchEventDocument>('MatchEvent', matchEventSchema);
