/**
 * Event REST service (T-30).
 *
 * Account-only Event management. Ownership is always derived from the
 * authenticated account; cross-owner access is rejected. Linking Match ↔ Event
 * remains in the existing Match REST endpoints (no Event link endpoint).
 */

import mongoose from 'mongoose';
import { ApiError } from '../../middleware/error.js';
import {
  archiveEvent,
  createEvent,
  findChildEvents,
  findEventById,
  findRootEventsByOwner,
  updateEventIfActive,
} from '../../repositories/event.repo.js';
import { findMatchesForEvent } from '../../repositories/match.repo.js';
import type { EventDocumentModel } from '../../models/index.js';
import { validateCreateEvent } from './validation.js';
import {
  toEventChildrenResponse,
  toEventGroups,
  toEventListResponse,
  toEventMatchesResponse,
  toEventSummary,
} from './event.serializers.js';
import type { EventSummary } from './event.serializers.js';
import type { CreateEventBody, UpdateEventBody } from './event.schemas.js';

async function loadOwnedEvent(eventId: string, accountId: string): Promise<EventDocumentModel> {
  if (!mongoose.isValidObjectId(eventId)) {
    throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  }

  const event = await findEventById(eventId);

  if (!event) {
    throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  }

  if (event.ownerId.toString() !== accountId) {
    throw new ApiError(403, 'EVENT_FORBIDDEN', 'You do not own this event.');
  }

  return event;
}

export async function createEventForAccount(
  input: CreateEventBody,
  accountId: string,
): Promise<EventSummary> {
  await validateCreateEvent({
    sport: input.sport,
    ownerId: accountId,
    parentId: input.parentId,
  });

  const event = await createEvent({
    name: input.name,
    sport: input.sport,
    ownerId: accountId,
    parentId: input.parentId,
    description: input.description,
    date: input.date,
  });

  return toEventSummary(event);
}

export async function listEventsForAccount(accountId: string) {
  const events = await findRootEventsByOwner(accountId);
  return toEventListResponse(events);
}

export async function getEventForAccount(
  eventId: string,
  accountId: string,
): Promise<EventSummary> {
  const event = await loadOwnedEvent(eventId, accountId);
  return toEventSummary(event);
}

export async function updateEventForAccount(
  eventId: string,
  accountId: string,
  input: UpdateEventBody,
): Promise<EventSummary> {
  const event = await loadOwnedEvent(eventId, accountId);

  if (event.archived) {
    throw new ApiError(409, 'EVENT_ARCHIVED', 'Archived events cannot be edited.');
  }

  const updated = await updateEventIfActive(eventId, input);

  if (!updated) {
    throw new ApiError(409, 'EVENT_ARCHIVED', 'Archived events cannot be edited.');
  }

  return toEventSummary(updated);
}

export async function archiveEventForAccount(
  eventId: string,
  accountId: string,
): Promise<EventSummary> {
  await loadOwnedEvent(eventId, accountId);

  const archived = await archiveEvent(eventId);

  if (!archived) {
    throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  }

  return toEventSummary(archived);
}

export async function listEventMatchesForAccount(eventId: string, accountId: string) {
  await loadOwnedEvent(eventId, accountId);
  const matches = await findMatchesForEvent(eventId);
  return toEventMatchesResponse(toEventGroups(matches));
}

export async function listEventChildrenForAccount(eventId: string, accountId: string) {
  await loadOwnedEvent(eventId, accountId);
  const children = await findChildEvents(eventId);
  return toEventChildrenResponse(children);
}
