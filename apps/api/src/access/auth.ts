/**
 * Account authentication primitives (T-10).
 *
 * - bcryptjs password hashing at cost 12;
 * - JWT signed with `JWT_SECRET`, delivered as an httpOnly cookie;
 * - `requireAccount` middleware for account-only endpoints.
 *
 * No password, hash, JWT, cookie, or secret is ever logged here.
 */

import { compare, hash } from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { AccountModel } from '../models/index.js';
import type { AccountDocument } from '../models/index.js';
import { ApiError } from '../middleware/error.js';

export const AUTH_COOKIE_NAME = 'skoriva_session';
export const JWT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const BCRYPT_COST = 12;
/** bcrypt only consumes the first 72 bytes; reject longer input explicitly. */
export const MAX_PASSWORD_BYTES = 72;

/**
 * A valid bcrypt hash used to keep login timing similar when the email does
 * not exist. It is not a real account password.
 */
export const DUMMY_PASSWORD_HASH = '$2b$12$.LOQphqqXa7o3xxJ5XE0MeiUlRcZ/K8kq7XArvfT99VL0mnE09r1m';

export async function hashPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return compare(password, passwordHash);
}

export function signAccountToken(accountId: string, secret = env.JWT_SECRET): string {
  return jwt.sign({}, secret, {
    subject: accountId,
    expiresIn: JWT_TTL_SECONDS,
  });
}

export function verifyAccountToken(token: string, secret = env.JWT_SECRET): string {
  try {
    const decoded = jwt.verify(token, secret);

    if (typeof decoded !== 'object' || decoded === null || typeof decoded.sub !== 'string') {
      throw new Error('JWT subject is missing.');
    }

    return decoded.sub;
  } catch {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Invalid or expired session.');
  }
}

export function getAuthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: JWT_TTL_SECONDS * 1000,
  };
}

export function setAuthCookie(response: Response, token: string): void {
  response.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());
}

export function clearAuthCookie(response: Response): void {
  const { maxAge: _maxAge, ...options } = getAuthCookieOptions();
  response.clearCookie(AUTH_COOKIE_NAME, options);
}

/**
 * Require a valid account session. Attaches the account to `request.account`.
 * Used by `/api/auth/me` and, from T-30 onward, Event endpoints.
 */
export async function requireAccount(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = request.cookies?.[AUTH_COOKIE_NAME];

    if (typeof token !== 'string' || token.length === 0) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.');
    }

    const accountId = verifyAccountToken(token);

    if (!mongoose.isValidObjectId(accountId)) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Invalid or expired session.');
    }

    const account = await AccountModel.findById(accountId).lean<AccountDocument>().exec();

    if (!account) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Invalid or expired session.');
    }

    request.account = account;
    next();
  } catch (error) {
    next(error);
  }
}
