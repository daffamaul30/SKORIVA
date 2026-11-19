/**
 * Optional account resolver (T-29).
 *
 * Attaches `request.account` when a valid account cookie is present, but does
 * not reject anonymous callers. Used by `POST /api/matches`, where Quick Match
 * is allowed without an account.
 */

import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { AUTH_COOKIE_NAME, verifyAccountToken } from '../access/auth.js';
import { AccountModel } from '../models/index.js';
import type { AccountDocument } from '../models/index.js';

export async function optionalAccount(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = request.cookies?.[AUTH_COOKIE_NAME];

    if (typeof token !== 'string' || token.length === 0) {
      next();
      return;
    }

    const accountId = verifyAccountToken(token);

    if (!mongoose.isValidObjectId(accountId)) {
      next();
      return;
    }

    const account = await AccountModel.findById(accountId).lean<AccountDocument>().exec();

    if (account) {
      request.account = account;
    }

    next();
  } catch {
    // An invalid/expired cookie is treated as anonymous for this endpoint.
    next();
  }
}
