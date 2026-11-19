/**
 * Event repository (T-08).
 *
 * Data access only. Same-owner rules, sport equality, hierarchy depth, and
 * archive-vs-delete decisions are enforced by the event module in T-19/T-30.
 * There is intentionally no hard-delete helper (BR-16).
 */

import { EventModel } from '../models/index.js';
import type { EventDocumentModel } from '../models/index.js';
import type { Sport } from '@skoriva/shared';

export interface CreateEventInput {
  name: string;
  sport: Sport;
  ownerId: string;
  parentId?: string;
  description?: string;
  date?: Date;
}

export type UpdateEventInput = Partial<Pick<EventDocumentModel, 'name' | 'description' | 'date'>>;

export interface EventListOptions {
  includeArchived?: boolean;
}

const EVENT_UPDATE_ALLOWLIST = [
  'name',
  'description',
  'date',
] as const satisfies readonly (keyof UpdateEventInput)[];

function sanitizeEventUpdate(patch: UpdateEventInput): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const key of EVENT_UPDATE_ALLOWLIST) {
    const value = patch[key];
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export async function createEvent(input: CreateEventInput): Promise<EventDocumentModel> {
  const document = await EventModel.create(input);
  return document.toObject() as EventDocumentModel;
}

export async function findEventById(eventId: string): Promise<EventDocumentModel | null> {
  return EventModel.findById(eventId).lean<EventDocumentModel>().exec();
}

export async function findEventsByOwner(
  ownerId: string,
  options: EventListOptions = {},
): Promise<EventDocumentModel[]> {
  const filter: Record<string, unknown> = { ownerId };

  if (!options.includeArchived) {
    filter.archived = false;
  }

  return EventModel.find(filter).sort({ createdAt: -1 }).lean<EventDocumentModel[]>().exec();
}

/** Root events only (no parentId); used by GET /api/events. */
export async function findRootEventsByOwner(
  ownerId: string,
  options: EventListOptions = {},
): Promise<EventDocumentModel[]> {
  const filter: Record<string, unknown> = {
    ownerId,
    parentId: { $exists: false },
  };

  if (!options.includeArchived) {
    filter.archived = false;
  }

  return EventModel.find(filter).sort({ createdAt: -1 }).lean<EventDocumentModel[]>().exec();
}

export async function findChildEvents(
  parentId: string,
  options: EventListOptions = {},
): Promise<EventDocumentModel[]> {
  const filter: Record<string, unknown> = { parentId };

  if (!options.includeArchived) {
    filter.archived = false;
  }

  return EventModel.find(filter).sort({ createdAt: -1 }).lean<EventDocumentModel[]>().exec();
}

export async function findEventWithChildren(
  eventId: string,
): Promise<{ event: EventDocumentModel; children: EventDocumentModel[] } | null> {
  const event = await findEventById(eventId);

  if (!event) return null;

  const children = await findChildEvents(eventId);

  return { event, children };
}

export async function updateEvent(
  eventId: string,
  patch: UpdateEventInput,
): Promise<EventDocumentModel | null> {
  const update = sanitizeEventUpdate(patch);

  if (Object.keys(update).length === 0) {
    return findEventById(eventId);
  }

  return EventModel.findByIdAndUpdate(eventId, { $set: update }, { new: true, runValidators: true })
    .lean<EventDocumentModel>()
    .exec();
}

/** Update only while the event is still active (not archived). */
export async function updateEventIfActive(
  eventId: string,
  patch: UpdateEventInput,
): Promise<EventDocumentModel | null> {
  const update = sanitizeEventUpdate(patch);

  if (Object.keys(update).length === 0) {
    return EventModel.findOne({ _id: eventId, archived: false }).lean<EventDocumentModel>().exec();
  }

  return EventModel.findOneAndUpdate(
    { _id: eventId, archived: false },
    { $set: update },
    { new: true, runValidators: true },
  )
    .lean<EventDocumentModel>()
    .exec();
}

export async function archiveEvent(eventId: string): Promise<EventDocumentModel | null> {
  return EventModel.findByIdAndUpdate(
    eventId,
    { $set: { archived: true } },
    { new: true, runValidators: true },
  )
    .lean<EventDocumentModel>()
    .exec();
}

export async function countChildEvents(parentId: string): Promise<number> {
  return EventModel.countDocuments({ parentId });
}
