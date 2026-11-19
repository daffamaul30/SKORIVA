/**
 * Event hierarchy, sport compatibility, and ownership validation (T-19).
 *
 * These rules are enforced in the backend, not only in the UI:
 * - Event creation requires an account owner (B-05).
 * - A match may only link to an event of the same sport (BR-15).
 * - A child event must match its parent's sport and owner, and depth is at most
 *   two levels (BR-15/BR-18, B-04).
 * - A match may only link to an event owned by the same account (B-04).
 * - Events with matches or children are archived, never hard-deleted (BR-16).
 */

import type { Sport } from '@skoriva/shared';
import type { EventDocumentModel, MatchDocument } from '../../models/index.js';
import { countChildEvents, countMatchesForEvent, findEventById } from '../../repositories/index.js';

export type EventValidationErrorCode =
  | 'EVENT_OWNER_REQUIRED'
  | 'EVENT_NOT_FOUND'
  | 'PARENT_EVENT_NOT_FOUND'
  | 'EVENT_DEPTH_EXCEEDED'
  | 'EVENT_SPORT_MISMATCH'
  | 'EVENT_OWNER_MISMATCH'
  | 'MATCH_EVENT_SPORT_MISMATCH'
  | 'MATCH_EVENT_OWNER_MISMATCH'
  | 'EVENT_HAS_DEPENDENCIES';

export class EventValidationError extends Error {
  constructor(
    readonly code: EventValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EventValidationError';
  }
}

export interface CreateEventValidationInput {
  sport: Sport;
  ownerId?: string;
  parentId?: string;
}

export function assertAccountOwner(ownerId: string | undefined): asserts ownerId is string {
  if (!ownerId || ownerId.trim().length === 0) {
    throw new EventValidationError('EVENT_OWNER_REQUIRED', 'Event ownership requires an account.');
  }
}

/**
 * Validate a new event. When `parentId` is present, the parent must exist, have
 * no parent of its own (max depth 2), and share sport and owner.
 */
export async function validateCreateEvent(
  input: CreateEventValidationInput,
): Promise<EventDocumentModel | null> {
  assertAccountOwner(input.ownerId);

  if (!input.parentId) return null;

  const parent = await findEventById(input.parentId);

  if (!parent) {
    throw new EventValidationError('PARENT_EVENT_NOT_FOUND', 'Parent event not found.');
  }

  if (parent.parentId !== undefined) {
    throw new EventValidationError(
      'EVENT_DEPTH_EXCEEDED',
      'Event hierarchy is limited to two levels.',
    );
  }

  if (parent.sport !== input.sport) {
    throw new EventValidationError(
      'EVENT_SPORT_MISMATCH',
      'A child event must use the same sport as its parent.',
    );
  }

  if (parent.ownerId.toString() !== input.ownerId) {
    throw new EventValidationError(
      'EVENT_OWNER_MISMATCH',
      'A child event must have the same owner as its parent.',
    );
  }

  return parent;
}

/** Validate a match → event link (sport and same-owner). */
export function validateMatchEventLink(
  match: Pick<MatchDocument, 'sport' | 'owner'>,
  event: Pick<EventDocumentModel, 'sport' | 'ownerId'>,
): void {
  if (match.sport !== event.sport) {
    throw new EventValidationError(
      'MATCH_EVENT_SPORT_MISMATCH',
      'A match can only be linked to an event of the same sport.',
    );
  }

  if (match.owner.id !== event.ownerId.toString()) {
    throw new EventValidationError(
      'MATCH_EVENT_OWNER_MISMATCH',
      'A match can only be linked to an event owned by the same account.',
    );
  }
}

/**
 * BR-16: an event with matches or children must be archived, not deleted.
 * Returns `true` when a hard delete is safe.
 */
export async function canHardDeleteEvent(eventId: string): Promise<boolean> {
  const [matches, children] = await Promise.all([
    countMatchesForEvent(eventId),
    countChildEvents(eventId),
  ]);

  return matches === 0 && children === 0;
}

export async function assertEventCanBeDeleted(eventId: string): Promise<void> {
  if (!(await canHardDeleteEvent(eventId))) {
    throw new EventValidationError(
      'EVENT_HAS_DEPENDENCIES',
      'Event has matches or child events; archive it instead of deleting.',
    );
  }
}
