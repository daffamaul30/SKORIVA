/**
 * REST endpoint definitions (T-31.2).
 *
 * Every entry mirrors a route that exists in `apps/api` today. Nothing here may
 * be invented: `GET /api/history` is intentionally absent because the backend
 * does not implement it.
 *
 * All paths are relative to the same-origin proxy (`API_BASE_PATH === '/api'`),
 * so the browser never addresses the backend origin directly.
 */

import { API_BASE_PATH } from '../api/base-path';

/** Encode a path segment without letting `/` or `?` escape into the path. */
function segment(value: string): string {
  return encodeURIComponent(value);
}

export const endpoints = {
  auth: {
    register: () => `${API_BASE_PATH}/auth/register`,
    login: () => `${API_BASE_PATH}/auth/login`,
    logout: () => `${API_BASE_PATH}/auth/logout`,
    me: () => `${API_BASE_PATH}/auth/me`,
  },

  matches: {
    create: () => `${API_BASE_PATH}/matches`,
    detail: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}`,
    update: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}`,
    start: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}/start`,
    finish: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}/finish`,
    cancel: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}/cancel`,
    reopen: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}/reopen`,
    saveResult: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}/save-result`,
    discardResult: (matchId: string) =>
      `${API_BASE_PATH}/matches/${segment(matchId)}/discard-result`,
    restoreResult: (matchId: string) =>
      `${API_BASE_PATH}/matches/${segment(matchId)}/restore-result`,
    correctResult: (matchId: string) =>
      `${API_BASE_PATH}/matches/${segment(matchId)}/correct-result`,
    events: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}/events`,
    result: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}/result`,
    claim: (matchId: string) => `${API_BASE_PATH}/matches/${segment(matchId)}/claim`,
  },

  events: {
    create: () => `${API_BASE_PATH}/events`,
    list: () => `${API_BASE_PATH}/events`,
    detail: (eventId: string) => `${API_BASE_PATH}/events/${segment(eventId)}`,
    update: (eventId: string) => `${API_BASE_PATH}/events/${segment(eventId)}`,
    archive: (eventId: string) => `${API_BASE_PATH}/events/${segment(eventId)}/archive`,
    matches: (eventId: string) => `${API_BASE_PATH}/events/${segment(eventId)}/matches`,
    children: (eventId: string) => `${API_BASE_PATH}/events/${segment(eventId)}/children`,
  },
} as const;

export type Endpoints = typeof endpoints;

/** Guard for tests and reviews: no endpoint may target the unimplemented history. */
export const UNAVAILABLE_ENDPOINTS = ['/api/history'] as const;
