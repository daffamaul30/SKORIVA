/**
 * Operator session management (T-11).
 *
 * Invariants (FR-28, B-09, R-01, R-02):
 * - exactly one active operator session per match;
 * - the active session is proven by an opaque credential sent as
 *   `X-Operator-Session` for REST lifecycle calls;
 * - a disconnect keeps the lock for a 30 second server-side grace window;
 * - handover uses a one-time, match/source-session bound code with a 2 minute
 *   TTL, stored as a hash and consumed atomically;
 * - control-token rotation only revokes the old control token and never
 *   touches the operator session (T-09 decision).
 *
 * Only hashes are stored. Plaintext credentials/codes are returned once and
 * are never logged.
 *
 * Socket.IO transport (`operator:state`, handover/rotate events) is T-28; this
 * module provides the service logic and event contracts only.
 */

import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MatchModel } from '../models/index.js';
import type { MatchDocument } from '../models/index.js';
import type { OperatorSession } from '@skoriva/shared';
import { appendEvents, loadMatchWithEvents } from '../repositories/match.repo.js';
import type { NewMatchEvent } from '../repositories/match.repo.js';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  rotateControlToken,
  TOKEN_DOMAINS,
} from './tokens.js';
import type { RotatedControlToken } from './tokens.js';

/** Server-side grace window after a disconnect (B-09). */
export const OPERATOR_GRACE_MS = 30_000;

/** One-time handover code lifetime (R-02). */
export const HANDOVER_CODE_TTL_MS = 2 * 60_000;

export const OPERATOR_CREDENTIAL_BYTES = 32;
export const HANDOVER_CODE_BYTES = 6;

/**
 * Operator sessions are bounded by match lifecycle and explicit revocation,
 * not by a fixed TTL. The schema still requires `expiresAt`, so a far-future
 * sentinel is used instead of a 24 hour expiry.
 */
export const OPERATOR_SESSION_NO_EXPIRY = new Date('9999-12-31T23:59:59.999Z');

/** REST lifecycle proof header (R-01). */
export const OPERATOR_SESSION_HEADER = 'x-operator-session';

export type OperatorSessionErrorCode =
  | 'MATCH_NOT_FOUND'
  | 'OPERATOR_SESSION_CONFLICT'
  | 'OPERATOR_SESSION_INVALID'
  | 'OPERATOR_SESSION_EXPIRED'
  | 'OPERATOR_SESSION_REVOKED'
  | 'OPERATOR_SESSION_STALE'
  | 'HANDOVER_CODE_INVALID'
  | 'HANDOVER_CODE_EXPIRED';

export class OperatorSessionError extends Error {
  constructor(
    readonly code: OperatorSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OperatorSessionError';
  }
}

export interface IssuedOperatorSession {
  sessionId: string;
  /** Plaintext credential; returned exactly once. */
  credential: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface IssuedHandoverCode {
  code: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface VerifiedOperatorSession {
  match: MatchDocument;
  session: OperatorSession;
}

function hashCredential(credential: string, pepper: string): string {
  return hashOpaqueToken(credential, pepper, TOKEN_DOMAINS.operatorSession);
}

function isSessionExpired(session: OperatorSession, now: Date): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}

function isSessionRevoked(session: OperatorSession): boolean {
  return session.revokedAt !== undefined;
}

function isGraceExpired(match: MatchDocument, now: Date): boolean {
  return (
    match.operatorGraceUntil !== undefined && match.operatorGraceUntil.getTime() <= now.getTime()
  );
}

/**
 * True when the match currently has a usable active operator session.
 * Lazy grace expiration is the source of truth; a sweep only cleans up.
 */
export function isOperatorActive(match: MatchDocument, now = new Date()): boolean {
  const session = match.access.operatorSession;

  if (!session || !match.activeOperatorId) return false;
  if (match.activeOperatorId !== session.sessionId) return false;
  if (isSessionRevoked(session) || isSessionExpired(session, now)) return false;
  if (isGraceExpired(match, now)) return false;

  return true;
}

async function findMatch(matchId: string): Promise<MatchDocument> {
  if (!mongoose.isValidObjectId(matchId)) {
    throw new OperatorSessionError('MATCH_NOT_FOUND', 'Match not found.');
  }

  const match = await MatchModel.findById(matchId).lean<MatchDocument>().exec();

  if (!match) {
    throw new OperatorSessionError('MATCH_NOT_FOUND', 'Match not found.');
  }

  return match;
}

/**
 * Lazy grace expiration. Clears the active operator and revokes the session
 * when the grace window has elapsed. Returns the updated match, or `null` when
 * no expiration was needed.
 */
export async function expireOperatorGraceIfNeeded(
  matchId: string,
  now = new Date(),
): Promise<MatchDocument | null> {
  if (!mongoose.isValidObjectId(matchId)) return null;

  return MatchModel.findOneAndUpdate(
    { _id: matchId, operatorGraceUntil: { $lte: now } },
    {
      $unset: { operatorGraceUntil: '', activeOperatorId: '' },
      $set: { 'access.operatorSession.revokedAt': now },
    },
    { new: true },
  )
    .lean<MatchDocument>()
    .exec();
}

/**
 * Cleanup sweep for expired grace windows. Lazy expiration remains the source
 * of truth; this only removes stale locks in bulk.
 */
export async function sweepExpiredOperatorSessions(now = new Date()): Promise<number> {
  const result = await MatchModel.updateMany(
    { operatorGraceUntil: { $lte: now } },
    {
      $unset: { operatorGraceUntil: '', activeOperatorId: '' },
      $set: { 'access.operatorSession.revokedAt': now },
    },
  );

  return result.modifiedCount;
}

/** Match ids whose grace window has elapsed; used by the realtime sweeper. */
export async function findExpiredOperatorGraceMatches(now = new Date()): Promise<string[]> {
  const matches = await MatchModel.find({ operatorGraceUntil: { $lte: now } })
    .select('_id')
    .lean<Array<{ _id: mongoose.Types.ObjectId }>>()
    .exec();

  return matches.map((match) => match._id.toString());
}

/**
 * Claim the single active operator slot. Atomic compare-and-set prevents two
 * operators from becoming active at the same time.
 */
export async function claimOperatorSession(
  matchId: string,
  pepper: string,
  now = new Date(),
): Promise<IssuedOperatorSession> {
  const match = await findMatch(matchId);

  if (isOperatorActive(match, now)) {
    throw new OperatorSessionError(
      'OPERATOR_SESSION_CONFLICT',
      'Another operator is currently active for this match.',
    );
  }

  const sessionId = randomUUID();
  const credential = generateOpaqueToken(OPERATOR_CREDENTIAL_BYTES);
  const credentialHash = hashCredential(credential, pepper);

  const updated = await MatchModel.findOneAndUpdate(
    {
      _id: matchId,
      $or: [
        { activeOperatorId: { $exists: false } },
        { activeOperatorId: null },
        { operatorGraceUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        'access.operatorSession': {
          sessionId,
          credentialHash,
          issuedAt: now,
          expiresAt: OPERATOR_SESSION_NO_EXPIRY,
        },
        activeOperatorId: sessionId,
      },
      $unset: { operatorGraceUntil: '' },
    },
    { new: true },
  )
    .lean<MatchDocument>()
    .exec();

  if (!updated) {
    throw new OperatorSessionError(
      'OPERATOR_SESSION_CONFLICT',
      'Another operator is currently active for this match.',
    );
  }

  return {
    sessionId,
    credential,
    issuedAt: now,
    expiresAt: OPERATOR_SESSION_NO_EXPIRY,
  };
}

/**
 * Reconnect with the same credential inside the grace window. Clears the grace
 * marker so the session becomes active again.
 */
export async function reconnectOperatorSession(
  matchId: string,
  credential: string,
  pepper: string,
  now = new Date(),
): Promise<VerifiedOperatorSession> {
  const credentialHash = hashCredential(credential, pepper);
  const match = await findMatch(matchId);
  const session = match.access.operatorSession;

  if (!session || session.credentialHash !== credentialHash) {
    throw new OperatorSessionError('OPERATOR_SESSION_INVALID', 'Operator session is not valid.');
  }

  if (isSessionRevoked(session)) {
    throw new OperatorSessionError('OPERATOR_SESSION_REVOKED', 'Operator session was revoked.');
  }

  if (isSessionExpired(session, now)) {
    throw new OperatorSessionError('OPERATOR_SESSION_EXPIRED', 'Operator session has expired.');
  }

  if (match.activeOperatorId !== session.sessionId) {
    throw new OperatorSessionError(
      'OPERATOR_SESSION_STALE',
      'Operator session is no longer the active session.',
    );
  }

  if (isGraceExpired(match, now)) {
    throw new OperatorSessionError('OPERATOR_SESSION_EXPIRED', 'Operator grace period has ended.');
  }

  const updated = await MatchModel.findOneAndUpdate(
    {
      _id: matchId,
      'access.operatorSession.credentialHash': credentialHash,
      activeOperatorId: session.sessionId,
    },
    { $unset: { operatorGraceUntil: '' } },
    { new: true },
  )
    .lean<MatchDocument>()
    .exec();

  if (!updated) {
    throw new OperatorSessionError('OPERATOR_SESSION_INVALID', 'Operator session is not active.');
  }

  return { match: updated, session };
}

/**
 * Mark the active operator as disconnected. The lock is retained for the grace
 * window so the same credential can reconnect.
 */
export async function markOperatorDisconnected(
  matchId: string,
  credential: string,
  pepper: string,
  now = new Date(),
): Promise<Date> {
  const credentialHash = hashCredential(credential, pepper);
  const graceUntil = new Date(now.getTime() + OPERATOR_GRACE_MS);

  const updated = await MatchModel.findOneAndUpdate(
    {
      _id: matchId,
      'access.operatorSession.credentialHash': credentialHash,
      'access.operatorSession.revokedAt': { $exists: false },
    },
    { $set: { operatorGraceUntil: graceUntil } },
    { new: true },
  )
    .lean<MatchDocument>()
    .exec();

  if (!updated) {
    throw new OperatorSessionError('OPERATOR_SESSION_INVALID', 'Operator session is not valid.');
  }

  return graceUntil;
}

/**
 * Verify an operator credential for REST lifecycle calls (R-01). Applies lazy
 * grace expiration before deciding.
 */
export async function verifyOperatorSession(
  matchId: string,
  credential: string,
  pepper: string,
  now = new Date(),
): Promise<VerifiedOperatorSession> {
  const credentialHash = hashCredential(credential, pepper);
  const match = await findMatch(matchId);
  const session = match.access.operatorSession;

  if (!session || session.credentialHash !== credentialHash) {
    throw new OperatorSessionError('OPERATOR_SESSION_INVALID', 'Operator session is not valid.');
  }

  if (isSessionRevoked(session)) {
    throw new OperatorSessionError('OPERATOR_SESSION_REVOKED', 'Operator session was revoked.');
  }

  if (isSessionExpired(session, now)) {
    throw new OperatorSessionError('OPERATOR_SESSION_EXPIRED', 'Operator session has expired.');
  }

  if (match.activeOperatorId !== session.sessionId) {
    throw new OperatorSessionError(
      'OPERATOR_SESSION_STALE',
      'Operator session is no longer the active session.',
    );
  }

  if (isGraceExpired(match, now)) {
    await expireOperatorGraceIfNeeded(matchId, now);
    throw new OperatorSessionError('OPERATOR_SESSION_EXPIRED', 'Operator grace period has ended.');
  }

  return { match, session };
}

/**
 * Create a one-time handover code bound to the match and the source session.
 * The code is stored as a hash and expires after two minutes.
 */
export async function createHandoverCode(
  matchId: string,
  credential: string,
  pepper: string,
  now = new Date(),
): Promise<IssuedHandoverCode> {
  const { session } = await verifyOperatorSession(matchId, credential, pepper, now);
  const code = generateOpaqueToken(HANDOVER_CODE_BYTES);
  const codeHash = hashOpaqueToken(code, pepper, TOKEN_DOMAINS.handoverCode);
  const expiresAt = new Date(now.getTime() + HANDOVER_CODE_TTL_MS);

  const updated = await MatchModel.findOneAndUpdate(
    {
      _id: matchId,
      'access.operatorSession.credentialHash': session.credentialHash,
      activeOperatorId: session.sessionId,
    },
    {
      $set: {
        'access.handoverCode': {
          codeHash,
          sourceSessionId: session.sessionId,
          issuedAt: now,
          expiresAt,
        },
      },
    },
    { new: true },
  )
    .lean<MatchDocument>()
    .exec();

  if (!updated) {
    throw new OperatorSessionError('OPERATOR_SESSION_INVALID', 'Operator session is not active.');
  }

  return { code, issuedAt: now, expiresAt };
}

/**
 * Consume a handover code atomically and transfer control to a new session.
 * The old session is replaced, so its credential stops working immediately.
 */
export async function acceptHandoverCode(
  matchId: string,
  code: string,
  pepper: string,
  now = new Date(),
): Promise<IssuedOperatorSession & { sourceSessionId: string }> {
  const codeHash = hashOpaqueToken(code, pepper, TOKEN_DOMAINS.handoverCode);
  const match = await findMatch(matchId);
  const handover = match.access.handoverCode;

  if (!handover || handover.codeHash !== codeHash) {
    throw new OperatorSessionError('HANDOVER_CODE_INVALID', 'Handover code is not valid.');
  }

  if (handover.usedAt !== undefined) {
    throw new OperatorSessionError('HANDOVER_CODE_INVALID', 'Handover code was already used.');
  }

  if (handover.expiresAt.getTime() <= now.getTime()) {
    throw new OperatorSessionError('HANDOVER_CODE_EXPIRED', 'Handover code has expired.');
  }

  const sessionId = randomUUID();
  const credential = generateOpaqueToken(OPERATOR_CREDENTIAL_BYTES);
  const credentialHash = hashCredential(credential, pepper);

  const updated = await MatchModel.findOneAndUpdate(
    {
      _id: matchId,
      'access.handoverCode.codeHash': codeHash,
      'access.handoverCode.usedAt': { $exists: false },
      'access.handoverCode.expiresAt': { $gt: now },
    },
    {
      $set: {
        'access.operatorSession': {
          sessionId,
          credentialHash,
          issuedAt: now,
          expiresAt: OPERATOR_SESSION_NO_EXPIRY,
        },
        'access.handoverCode.usedAt': now,
        activeOperatorId: sessionId,
      },
      $unset: { operatorGraceUntil: '' },
    },
    { new: true },
  )
    .lean<MatchDocument>()
    .exec();

  if (!updated) {
    throw new OperatorSessionError('HANDOVER_CODE_INVALID', 'Handover code is not valid.');
  }

  await appendOperatorEvent(
    matchId,
    'operator.handover',
    { fromSessionId: handover.sourceSessionId, toSessionId: sessionId },
    sessionId,
    now,
  );

  return {
    sessionId,
    credential,
    issuedAt: now,
    expiresAt: OPERATOR_SESSION_NO_EXPIRY,
    sourceSessionId: handover.sourceSessionId,
  };
}

/**
 * Rotate the control token. Per the T-09 decision this only revokes the old
 * control token; the operator session and `activeOperatorId` are untouched.
 */
export async function rotateOperatorControlToken(
  matchId: string,
  pepper: string,
  now = new Date(),
): Promise<RotatedControlToken> {
  const rotated = await rotateControlToken(matchId, pepper, now);

  await appendOperatorEvent(
    matchId,
    'operator.tokenRotate',
    { issuedAt: now.toISOString() },
    undefined,
    now,
  );

  return rotated;
}

/**
 * `operator:state` payload contract for T-28. A client that is not the active
 * operator receives `{ active: false }`; the active client also gets its id.
 */
export interface OperatorState {
  active: boolean;
  sessionId?: string;
}

export async function getOperatorState(
  matchId: string,
  credential: string,
  pepper: string,
  now = new Date(),
): Promise<OperatorState> {
  try {
    const { session } = await verifyOperatorSession(matchId, credential, pepper, now);
    return { active: true, sessionId: session.sessionId };
  } catch {
    return { active: false };
  }
}

/**
 * Append an access event. T-14 owns the general event log; this helper keeps
 * T-11 self-contained because operator events are produced outside the action
 * pipeline. Sequence assignment is monotonic per match.
 */
async function appendOperatorEvent(
  matchId: string,
  type: 'operator.handover' | 'operator.tokenRotate',
  payload: Record<string, unknown>,
  actorId: string | undefined,
  now: Date,
): Promise<NewMatchEvent | null> {
  const loaded = await loadMatchWithEvents(matchId);

  if (!loaded) return null;

  const seq = loaded.maxSeq + 1;
  const event: NewMatchEvent = {
    seq,
    txId: `op-${type}-${randomUUID()}`,
    type,
    payload,
    actor: { type: 'operator', id: actorId },
    serverTs: now,
    appliedAt: now,
  };

  await appendEvents(matchId, [event]);
  return event;
}
