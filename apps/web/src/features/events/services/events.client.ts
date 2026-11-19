/**
 * Event Management REST service (T-31.4).
 *
 * Every call is account-authenticated (cookie via `apiClient`). Ownership is
 * derived server-side; there is no transfer, invitation, or Event claim in the
 * MVP, so no such function exists here.
 */

import { endpoints } from '@/lib/api/endpoints';
import { apiClient } from '@/lib/api/http-client';
import type {
  CreateEventInput,
  EventChildrenResponse,
  EventListResponse,
  EventMatchesResponse,
  EventSummary,
  UpdateEventInput,
} from './events.types';

/** `POST /api/events` → 201 `EventSummary`. */
export async function createEvent(input: CreateEventInput): Promise<EventSummary> {
  return apiClient.post<EventSummary>(endpoints.events.create(), input);
}

/** `GET /api/events` → `{ events }` for the authenticated account. */
export async function listEvents(): Promise<EventListResponse> {
  return apiClient.get<EventListResponse>(endpoints.events.list());
}

/** `GET /api/events/:id` → `EventSummary` (404 `EVENT_NOT_FOUND`, 403 `EVENT_FORBIDDEN`). */
export async function getEvent(eventId: string): Promise<EventSummary> {
  return apiClient.get<EventSummary>(endpoints.events.detail(eventId));
}

/** `PATCH /api/events/:id` → `EventSummary`; name/description/date only. */
export async function updateEvent(
  eventId: string,
  input: UpdateEventInput,
): Promise<EventSummary> {
  return apiClient.patch<EventSummary>(endpoints.events.update(eventId), input);
}

/** `POST /api/events/:id/archive` → `EventSummary` with `archived: true`. */
export async function archiveEvent(eventId: string): Promise<EventSummary> {
  return apiClient.post<EventSummary>(endpoints.events.archive(eventId), {});
}

/** `GET /api/events/:id/matches` → minimal viewer groups (READY/LIVE/saved only). */
export async function listEventMatches(eventId: string): Promise<EventMatchesResponse> {
  return apiClient.get<EventMatchesResponse>(endpoints.events.matches(eventId));
}

/** `GET /api/events/:id/children` → direct child events (max two levels). */
export async function listEventChildren(eventId: string): Promise<EventChildrenResponse> {
  return apiClient.get<EventChildrenResponse>(endpoints.events.children(eventId));
}
