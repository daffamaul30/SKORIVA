/**
 * Event REST router (T-30).
 *
 * Account-only CRUD/archive/children/grouped matches. No DELETE, unarchive, or
 * Event link/unlink endpoints are exposed.
 */

import { Router } from 'express';
import type { Request } from 'express';
import { requireAccount } from '../../access/auth.js';
import { ApiError } from '../../middleware/error.js';
import {
  archiveEventSchema,
  createEventSchema,
  parseRequest,
  updateEventSchema,
} from './event.schemas.js';
import {
  archiveEventForAccount,
  createEventForAccount,
  getEventForAccount,
  listEventChildrenForAccount,
  listEventMatchesForAccount,
  listEventsForAccount,
  updateEventForAccount,
} from './event.service.js';

export const eventRouter = Router();

eventRouter.use(requireAccount);

function requireEventId(request: Request): string {
  const value = request.params.eventId;

  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'INVALID_EVENT_ID', 'eventId is required.');
  }

  return value;
}

function accountId(request: Request): string {
  if (!request.account) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.');
  }

  return request.account._id.toString();
}

eventRouter.post('/', async (request, response) => {
  const input = parseRequest(createEventSchema, request.body);
  const event = await createEventForAccount(input, accountId(request));

  response.status(201).json(event);
});

eventRouter.get('/', async (request, response) => {
  const result = await listEventsForAccount(accountId(request));
  response.status(200).json(result);
});

eventRouter.get('/:eventId', async (request, response) => {
  const event = await getEventForAccount(requireEventId(request), accountId(request));
  response.status(200).json(event);
});

eventRouter.patch('/:eventId', async (request, response) => {
  const input = parseRequest(updateEventSchema, request.body);
  const event = await updateEventForAccount(requireEventId(request), accountId(request), input);

  response.status(200).json(event);
});

eventRouter.post('/:eventId/archive', async (request, response) => {
  parseRequest(archiveEventSchema, request.body ?? {});
  const event = await archiveEventForAccount(requireEventId(request), accountId(request));

  response.status(200).json(event);
});

eventRouter.get('/:eventId/matches', async (request, response) => {
  const result = await listEventMatchesForAccount(requireEventId(request), accountId(request));

  response.status(200).json(result);
});

eventRouter.get('/:eventId/children', async (request, response) => {
  const result = await listEventChildrenForAccount(requireEventId(request), accountId(request));

  response.status(200).json(result);
});
