/**
 * Event (grouping) document (PRD FR-23, Tech Spec §2.3 `events`).
 *
 * Events are the only grouping entity in the MVP: there is no separate
 * competition/tournament entity (PRD D-01, Tech Spec §2.3 / Open Decisions C).
 *
 * Rules:
 * - `sport` is required; one event is exactly one sport (BR-18).
 * - `ownerId` requires an account; no anonymous event ownership (B-05).
 * - `parentId` is optional, max two levels (event parent cannot have its own parent).
 * - Child sport must equal parent sport (BR-15).
 * - Archived instead of hard deletion when matches or children exist (BR-16).
 */

import type { Sport } from './sport.js';

export interface EventDocument {
  id: string;
  /** Required. MVP technical limit: 120 characters (see `TEXT_LIMITS.eventName`). */
  name: string;
  sport: Sport;
  /** `undefined` = top-level event. Maximum depth is two levels (BR-18). */
  parentId?: string;
  /** Optional. MVP technical limit: 500 characters. */
  description?: string;
  date?: Date;
  /** Account id of the owner (B-05). */
  ownerId: string;
  archived: boolean;
  createdAt: Date;
}

/** Maximum event nesting depth (BR-18: parent → child only). */
export const MAX_EVENT_DEPTH = 2 as const;
