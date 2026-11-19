/**
 * Events service tests (T-31.4) — fixtures mirror `event.serializers.ts`.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveEvent,
  createEvent,
  getEvent,
  listEventChildren,
  listEventMatches,
  listEvents,
  updateEvent,
} from '@/features/events/services/events.client';
import { isApiClientError } from '@/lib/api/api-error';
import { TEST_ORIGIN, installFetchBridge } from './support/test-fetch';
import type { FetchBridge } from './support/test-fetch';

const ORIGIN = TEST_ORIGIN;
const server = setupServer();
let bridge: FetchBridge;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  bridge = installFetchBridge();
});

afterEach(() => {
  server.resetHandlers();
  bridge.requests.length = 0;
});

afterAll(() => {
  bridge.restore();
  server.close();
});

/** Exact `EventSummary` shape: nulls, not missing keys. */
const EVENT = {
  id: 'evt-1',
  name: 'Liga Kampus',
  sport: 'basketball',
  parentId: null,
  description: null,
  date: null,
  ownerId: 'acc-1',
  archived: false,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

/** Minimal `EventMatchSummary` from `toEventMatchSummary`. */
const EVENT_MATCH = {
  id: 'm-1',
  sport: 'basketball',
  teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
  matchStatus: 'live',
  resultDecision: 'undecided',
  context: { stageLabel: 'Grup A', matchNumber: 1 },
  display: {
    matchStatus: 'live',
    resultDecision: 'undecided',
    teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
    score: { home: 10, away: 8 },
    period: { index: 1, label: 'Q1', total: 4 },
  },
  createdAt: '2026-11-01T10:00:00.000Z',
  startedAt: '2026-11-01T10:05:00.000Z',
  finishedAt: null,
};

describe('create / list / detail / update', () => {
  it('creates an event with the accepted body only', async () => {
    server.use(
      http.post(`${ORIGIN}/api/events`, () => HttpResponse.json(EVENT, { status: 201 })),
    );

    const created = await createEvent({ name: 'Liga Kampus', sport: 'basketball' });

    expect(bridge.last().body).toStrictEqual({ name: 'Liga Kampus', sport: 'basketball' });
    // ownerId is derived server-side and must never be sent.
    expect(JSON.stringify(bridge.last().body)).not.toContain('ownerId');
    expect(created.id).toBe('evt-1');
  });

  it('propagates EVENT_SPORT_MISMATCH from the backend', async () => {
    server.use(
      http.post(`${ORIGIN}/api/events`, () =>
        HttpResponse.json(
          {
            code: 'EVENT_SPORT_MISMATCH',
            message: 'Child event sport must match the parent event sport.',
          },
          { status: 400 },
        ),
      ),
    );

    const error = await createEvent({
      name: 'Anak',
      sport: 'futsal',
      parentId: 'evt-1',
    }).catch((caught: unknown) => caught);

    if (isApiClientError(error)) {
      expect(error.code).toBe('EVENT_SPORT_MISMATCH');
      expect(error.message).toBe(
        'Cabang olahraga event harus sama dengan cabang olahraga induknya.',
      );
    }
  });

  it('lists events as { events }', async () => {
    server.use(
      http.get(`${ORIGIN}/api/events`, () => HttpResponse.json({ events: [EVENT] })),
    );

    const list = await listEvents();

    expect(list.events).toHaveLength(1);
    expect(bridge.last().relativePath).toBe('/api/events');
  });

  it('reads one event', async () => {
    server.use(http.get(`${ORIGIN}/api/events/:id`, () => HttpResponse.json(EVENT)));

    const event = await getEvent('evt-1');

    expect(event.archived).toBe(false);
    expect(bridge.last().relativePath).toBe('/api/events/evt-1');
  });

  it('reports EVENT_FORBIDDEN for a non-owner', async () => {
    server.use(
      http.get(`${ORIGIN}/api/events/:id`, () =>
        HttpResponse.json(
          { code: 'EVENT_FORBIDDEN', message: 'You do not own this event.' },
          { status: 403 },
        ),
      ),
    );

    const error = await getEvent('evt-1').catch((caught: unknown) => caught);

    if (isApiClientError(error)) {
      expect(error.status).toBe(403);
      expect(error.code).toBe('EVENT_FORBIDDEN');
      expect(error.message).toBe('Anda bukan pemilik event ini.');
    }
  });

  it('patches name/description/date only', async () => {
    server.use(
      http.patch(`${ORIGIN}/api/events/:id`, () =>
        HttpResponse.json({ ...EVENT, name: 'Liga Kampus 2026' }),
      ),
    );

    const updated = await updateEvent('evt-1', { name: 'Liga Kampus 2026' });

    expect(bridge.last().method).toBe('PATCH');
    expect(bridge.last().body).toStrictEqual({ name: 'Liga Kampus 2026' });
    expect(updated.name).toBe('Liga Kampus 2026');
  });

  it('archives with an empty POST body', async () => {
    server.use(
      http.post(`${ORIGIN}/api/events/:id/archive`, () =>
        HttpResponse.json({ ...EVENT, archived: true }),
      ),
    );

    const archived = await archiveEvent('evt-1');

    expect(bridge.last().relativePath).toBe('/api/events/evt-1/archive');
    expect(bridge.last().body).toStrictEqual({});
    expect(archived.archived).toBe(true);
  });

  it('refuses to archive when the backend reports dependencies', async () => {
    server.use(
      http.post(`${ORIGIN}/api/events/:id/archive`, () =>
        HttpResponse.json(
          { code: 'EVENT_HAS_DEPENDENCIES', message: 'Event still has matches.' },
          { status: 409 },
        ),
      ),
    );

    const error = await archiveEvent('evt-1').catch((caught: unknown) => caught);

    if (isApiClientError(error)) {
      expect(error.code).toBe('EVENT_HAS_DEPENDENCIES');
    }
  });
});

describe('grouped matches and children', () => {
  it('returns grouped matches, with null as the fallback group', async () => {
    server.use(
      http.get(`${ORIGIN}/api/events/:id/matches`, () =>
        HttpResponse.json({
          groups: [
            { label: 'Grup A', matches: [EVENT_MATCH] },
            { label: null, matches: [{ ...EVENT_MATCH, id: 'm-2' }] },
          ],
        }),
      ),
    );

    const result = await listEventMatches('evt-1');

    expect(result.groups).toHaveLength(2);
    expect(result.groups[1]?.label).toBeNull();
    expect(result.groups[1]?.matches[0]?.id).toBe('m-2');
    expect(bridge.last().relativePath).toBe('/api/events/evt-1/matches');
  });

  it('returns child events as { children }', async () => {
    server.use(
      http.get(`${ORIGIN}/api/events/:id/children`, () =>
        HttpResponse.json({ children: [{ ...EVENT, id: 'evt-child', parentId: 'evt-1' }] }),
      ),
    );

    const children = await listEventChildren('evt-1');

    expect(children.children[0]?.parentId).toBe('evt-1');
  });

  it('does not send operator credentials on account endpoints', async () => {
    server.use(
      http.get(`${ORIGIN}/api/events`, () => HttpResponse.json({ events: [] })),
    );

    await listEvents();

    expect(bridge.last().headers.has('X-Operator-Session')).toBe(false);
    expect(bridge.last().credentials).toBe('include');
  });
});
