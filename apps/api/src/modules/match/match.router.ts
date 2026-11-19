/**
 * Match REST router (T-29).
 *
 * REST owns create/read/update, lifecycle, result, event log, and claim.
 * Operational actions (score, clock, period, sport actions, undo) remain
 * Socket.IO-only; there is no REST fallback.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { requireAccount } from '../../access/auth.js';
import { OPERATOR_SESSION_HEADER } from '../../access/operator-session.js';
import { ApiError } from '../../middleware/error.js';
import {
  optionalAccount,
  requireOperatorSession,
  requireViewerAccess,
} from '../../middleware/index.js';
import {
  claimMatchSchema,
  correctResultBodySchema,
  createMatchSchema,
  eventListQuerySchema,
  lifecycleBodySchema,
  parseRequest,
  updateMatchSchema,
} from './match.schemas.js';
import {
  claimMatchForAccount,
  createMatchForRequest,
  dispatchCorrectResult,
  dispatchLifecycle,
  dispatchRestoreResult,
  listMatchEventsForOperator,
  matchDisplay,
  updateMatchForOperator,
} from './match.service.js';
import type { LifecycleActionName } from './match.service.js';
import {
  toCorrectionResponse,
  toCreateMatchResponse,
  toEventListResponse,
  toLifecycleResponse,
  toOperatorMatchResponse,
  toPublicResultResponse,
  toViewerMatchResponse,
} from './match.serializers.js';

export const matchRouter = Router();

async function requireAnyMatchAccess(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  if (request.get(OPERATOR_SESSION_HEADER)) {
    await requireOperatorSession(request, response, next);
    return;
  }

  await requireViewerAccess(request, response, next);
}

function requireMatchId(request: Request): string {
  const value = request.params.matchId;

  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'INVALID_MATCH_ID', 'matchId is required.');
  }

  return value;
}

function sendVersionConflict(
  response: Response,
  result: { version: number; snapshot: unknown },
): void {
  response.status(409).json({
    code: 'VERSION_CONFLICT',
    message: 'expectedVersion is stale; reload the match snapshot.',
    currentVersion: result.version,
    snapshot: result.snapshot,
  });
}

matchRouter.post('/', optionalAccount, async (request, response) => {
  const input = parseRequest(createMatchSchema, request.body);
  const accountId = request.account?._id.toString();
  const result = await createMatchForRequest(input, accountId);

  response
    .status(201)
    .json(
      toCreateMatchResponse(result.match, result.display, result.controlToken, result.viewCode),
    );
});

matchRouter.get('/:matchId', requireAnyMatchAccess, (request, response) => {
  const match = request.match!;
  const display = matchDisplay(match);

  if (request.operatorSession) {
    response.status(200).json(toOperatorMatchResponse(match, display));
    return;
  }

  response.status(200).json(toViewerMatchResponse(match, display));
});

matchRouter.patch('/:matchId', requireOperatorSession, async (request, response) => {
  const input = parseRequest(updateMatchSchema, request.body);
  const credential = request.get(OPERATOR_SESSION_HEADER) ?? '';
  const result = await updateMatchForOperator(requireMatchId(request), input, credential);

  response.status(200).json(toOperatorMatchResponse(result.match, result.display));
});

function lifecycleHandler(action: Exclude<LifecycleActionName, 'restore' | 'correct'>) {
  return async (request: Request, response: Response): Promise<void> => {
    const body = parseRequest(lifecycleBodySchema, request.body);
    const credential = request.get(OPERATOR_SESSION_HEADER) ?? '';
    const result = await dispatchLifecycle(requireMatchId(request), action, body, credential);

    if (result.status === 'version_conflict') {
      sendVersionConflict(response, result);
      return;
    }

    response.status(200).json(toLifecycleResponse(result));
  };
}

matchRouter.post('/:matchId/start', requireOperatorSession, lifecycleHandler('start'));
matchRouter.post('/:matchId/finish', requireOperatorSession, lifecycleHandler('finish'));
matchRouter.post('/:matchId/cancel', requireOperatorSession, lifecycleHandler('cancel'));
matchRouter.post('/:matchId/reopen', requireOperatorSession, lifecycleHandler('reopen'));
matchRouter.post('/:matchId/save-result', requireOperatorSession, lifecycleHandler('save'));
matchRouter.post('/:matchId/discard-result', requireOperatorSession, lifecycleHandler('discard'));

matchRouter.post('/:matchId/restore-result', requireOperatorSession, async (request, response) => {
  const body = parseRequest(lifecycleBodySchema, request.body);
  const credential = request.get(OPERATOR_SESSION_HEADER) ?? '';
  const result = await dispatchRestoreResult(requireMatchId(request), body, credential);

  if (result.status === 'version_conflict') {
    sendVersionConflict(response, result);
    return;
  }

  response.status(200).json(toLifecycleResponse(result));
});

matchRouter.post('/:matchId/correct-result', requireOperatorSession, async (request, response) => {
  const body = parseRequest(correctResultBodySchema, request.body);
  const credential = request.get(OPERATOR_SESSION_HEADER) ?? '';
  const result = await dispatchCorrectResult(requireMatchId(request), body, credential);

  if (result.status === 'version_conflict') {
    sendVersionConflict(response, result);
    return;
  }

  response.status(200).json(toCorrectionResponse(result));
});

matchRouter.get('/:matchId/events', requireOperatorSession, async (request, response) => {
  const query = parseRequest(eventListQuerySchema, request.query);
  const result = await listMatchEventsForOperator(requireMatchId(request), query);

  response.status(200).json(toEventListResponse(result.events, result.nextBeforeSeq));
});

matchRouter.get('/:matchId/result', requireViewerAccess, (request, response) => {
  const match = request.match!;
  const display = matchDisplay(match);

  response.status(200).json(toPublicResultResponse(match, display));
});

matchRouter.post('/:matchId/claim', requireAccount, async (request, response) => {
  const body = parseRequest(claimMatchSchema, request.body);
  const accountId = request.account!._id.toString();
  const result = await claimMatchForAccount(requireMatchId(request), accountId, body.controlToken);

  response.status(200).json(toOperatorMatchResponse(result.match, result.display));
});
