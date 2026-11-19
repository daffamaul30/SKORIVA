/**
 * `events` schema (T-07, Tech Spec §2.3 / §2.5).
 *
 * One event has exactly one sport; `ownerId` is a required account (B-05).
 * Parent depth and sport equality are validated by the event module in
 * T-19/T-30, not by this schema.
 */

import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose';
import type { Sport } from '@skoriva/shared';
import { SPORTS } from './enums.js';

export interface EventDocumentModel {
  _id: Types.ObjectId;
  name: string;
  sport: Sport;
  parentId?: Types.ObjectId;
  description?: string;
  date?: Date;
  ownerId: Types.ObjectId;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const eventSchema = new mongoose.Schema<EventDocumentModel>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    sport: { type: String, enum: [...SPORTS], required: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
    description: { type: String, trim: true, maxlength: 500 },
    date: { type: Date },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    archived: { type: Boolean, required: true, default: false },
  },
  {
    collection: 'events',
    versionKey: false,
    timestamps: true,
  },
);

eventSchema.index({ ownerId: 1, archived: 1 });
eventSchema.index({ parentId: 1, archived: 1 });

export type EventHydratedDocument = HydratedDocument<EventDocumentModel>;

export const EventModel: Model<EventDocumentModel> =
  (mongoose.models.Event as Model<EventDocumentModel> | undefined) ??
  mongoose.model<EventDocumentModel>('Event', eventSchema);
