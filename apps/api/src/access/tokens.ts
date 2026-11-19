/**
 * Opaque token and view-code generation/hashing (T-09).
 *
 * Security rules:
 * - `controlToken` is 32 random bytes (256-bit).
 * - `viewCode` is 16 random bytes (128-bit minimum).
 * - Only HMAC-SHA256 hashes are stored in MongoDB.
 * - Plaintext is returned only from creation/rotation results.
 * - No token, view code, pepper, or hash is ever logged here.
 */

import { createHmac, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { MatchModel } from '../models/index.js';
import type { MatchDocument } from '../models/index.js';
import type { MatchAccess } from '@skoriva/shared';

export const CONTROL_TOKEN_BYTES = 32;
export const VIEW_CODE_BYTES = 16;
export const TOKEN_HASH_ALGORITHM = 'sha256';

/**
 * Domain separation prevents a value from one credential class from ever
 * matching a hash from another class (control token vs view code vs operator
 * session vs handover code).
 */
export const TOKEN_DOMAINS = {
  controlToken: 'control-token',
  viewCode: 'view-code',
  operatorSession: 'operator-session',
  handoverCode: 'handover-code',
} as const;

export type TokenDomain = (typeof TOKEN_DOMAINS)[keyof typeof TOKEN_DOMAINS];

export type AccessErrorCode = 'MATCH_NOT_FOUND' | 'ACCESS_ROTATION_CONFLICT';

export class AccessError extends Error {
  constructor(
    readonly code: AccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export interface MatchCredentials {
  controlToken: string;
  viewCode: string;
  access: MatchAccess;
}

export interface RotatedControlToken {
  controlToken: string;
  issuedAt: Date;
}

export interface RotatedViewCode {
  viewCode: string;
  issuedAt: Date;
}

/** Generate a cryptographically secure opaque token encoded as base64url. */
export function generateOpaqueToken(byteLength: number): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error('Token byte length must be a positive integer.');
  }

  return randomBytes(byteLength).toString('base64url');
}

/** Domain-separated HMAC-SHA256 hash of an opaque token. */
export function hashOpaqueToken(token: string, pepper: string, domain: TokenDomain): string {
  if (token.length === 0) {
    throw new Error('Token must not be empty.');
  }
  if (pepper.length === 0) {
    throw new Error('TOKEN_PEPPER must not be empty.');
  }

  return createHmac(TOKEN_HASH_ALGORITHM, pepper).update(`${domain}\u0000${token}`).digest('hex');
}

/**
 * Create the access material for a new match. The caller must persist
 * `access` and return the plaintext values to the user exactly once.
 */
export function createMatchCredentials(pepper: string, now = new Date()): MatchCredentials {
  const controlToken = generateOpaqueToken(CONTROL_TOKEN_BYTES);
  const viewCode = generateOpaqueToken(VIEW_CODE_BYTES);

  return {
    controlToken,
    viewCode,
    access: {
      controlTokenHash: hashOpaqueToken(controlToken, pepper, TOKEN_DOMAINS.controlToken),
      viewCodeHash: hashOpaqueToken(viewCode, pepper, TOKEN_DOMAINS.viewCode),
      viewCodeIssuedAt: now,
      tokenIssuedAt: now,
      revokedTokenHashes: [],
      revokedViewCodeHashes: [],
    },
  };
}

async function findMatchForRotation(matchId: string): Promise<MatchDocument> {
  if (!mongoose.isValidObjectId(matchId)) {
    throw new AccessError('MATCH_NOT_FOUND', 'Match not found.');
  }

  const match = await MatchModel.findById(matchId).lean<MatchDocument>().exec();

  if (!match) {
    throw new AccessError('MATCH_NOT_FOUND', 'Match not found.');
  }

  return match;
}

/**
 * Rotate the owner/operator control token. The old hash is revoked atomically
 * by matching the current hash in the update filter. Match status is untouched.
 */
export async function rotateControlToken(
  matchId: string,
  pepper: string,
  now = new Date(),
): Promise<RotatedControlToken> {
  const match = await findMatchForRotation(matchId);
  const oldHash = match.access.controlTokenHash;
  const controlToken = generateOpaqueToken(CONTROL_TOKEN_BYTES);
  const newHash = hashOpaqueToken(controlToken, pepper, TOKEN_DOMAINS.controlToken);

  const updated = await MatchModel.findOneAndUpdate(
    { _id: matchId, 'access.controlTokenHash': oldHash },
    {
      $set: {
        'access.controlTokenHash': newHash,
        'access.tokenIssuedAt': now,
      },
      $addToSet: {
        'access.revokedTokenHashes': oldHash,
      },
    },
    { new: true },
  )
    .lean<MatchDocument>()
    .exec();

  if (!updated) {
    throw new AccessError(
      'ACCESS_ROTATION_CONFLICT',
      'Control token was rotated by another request.',
    );
  }

  return { controlToken, issuedAt: now };
}

/**
 * Rotate the viewer code. The old hash is revoked atomically and the match
 * status/result are untouched. Socket disconnection is handled by T-28.
 */
export async function rotateViewCode(
  matchId: string,
  pepper: string,
  now = new Date(),
): Promise<RotatedViewCode> {
  const match = await findMatchForRotation(matchId);
  const oldHash = match.access.viewCodeHash;
  const viewCode = generateOpaqueToken(VIEW_CODE_BYTES);
  const newHash = hashOpaqueToken(viewCode, pepper, TOKEN_DOMAINS.viewCode);

  const updated = await MatchModel.findOneAndUpdate(
    { _id: matchId, 'access.viewCodeHash': oldHash },
    {
      $set: {
        'access.viewCodeHash': newHash,
        'access.viewCodeIssuedAt': now,
      },
      $addToSet: {
        'access.revokedViewCodeHashes': oldHash,
      },
    },
    { new: true },
  )
    .lean<MatchDocument>()
    .exec();

  if (!updated) {
    throw new AccessError('ACCESS_ROTATION_CONFLICT', 'View code was rotated by another request.');
  }

  return { viewCode, issuedAt: now };
}
