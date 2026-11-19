/**
 * Basic access guard (T-09).
 *
 * Resolves whether a caller is the operator (valid control token) or a viewer
 * (valid view code) for a specific match. Active operator sessions, grace
 * periods, handover, and socket lifecycle are handled by T-11/T-28.
 *
 * Access denial returns `null`; no plaintext credential is ever returned or
 * logged.
 */

import mongoose from 'mongoose';
import { MatchModel } from '../models/index.js';
import type { MatchDocument } from '../models/index.js';
import { hashOpaqueToken, TOKEN_DOMAINS } from './tokens.js';

export type AccessRole = 'operator' | 'viewer';

export interface AccessCredentials {
  controlToken?: string;
  viewCode?: string;
}

export interface AccessGrant {
  role: AccessRole;
  match: MatchDocument;
}

/**
 * Resolve access for a match. A valid control token takes precedence over a
 * view code. Invalid credentials and unknown matches both return `null`.
 */
export async function resolveMatchAccess(
  matchId: string,
  credentials: AccessCredentials,
  pepper: string,
): Promise<AccessGrant | null> {
  if (!mongoose.isValidObjectId(matchId)) {
    return null;
  }

  if (credentials.controlToken) {
    const controlTokenHash = hashOpaqueToken(
      credentials.controlToken,
      pepper,
      TOKEN_DOMAINS.controlToken,
    );
    const match = await MatchModel.findOne({
      _id: matchId,
      'access.controlTokenHash': controlTokenHash,
    })
      .lean<MatchDocument>()
      .exec();

    if (match) {
      return { role: 'operator', match };
    }
  }

  if (credentials.viewCode) {
    const viewCodeHash = hashOpaqueToken(credentials.viewCode, pepper, TOKEN_DOMAINS.viewCode);
    const match = await MatchModel.findOne({
      _id: matchId,
      'access.viewCodeHash': viewCodeHash,
    })
      .lean<MatchDocument>()
      .exec();

    if (match) {
      return { role: 'viewer', match };
    }
  }

  return null;
}

export async function resolveOperatorAccess(
  matchId: string,
  controlToken: string,
  pepper: string,
): Promise<AccessGrant | null> {
  const grant = await resolveMatchAccess(matchId, { controlToken }, pepper);
  return grant?.role === 'operator' ? grant : null;
}

export async function resolveViewerAccess(
  matchId: string,
  viewCode: string,
  pepper: string,
): Promise<AccessGrant | null> {
  const grant = await resolveMatchAccess(matchId, { viewCode }, pepper);
  return grant?.role === 'viewer' ? grant : null;
}
