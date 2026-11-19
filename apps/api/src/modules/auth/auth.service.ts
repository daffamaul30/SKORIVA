/**
 * Account auth service (T-10).
 *
 * Data access for accounts lives here; HTTP concerns stay in the router.
 * Login errors are intentionally generic so they do not reveal whether an
 * email is registered.
 */

import { AccountModel } from '../../models/index.js';
import type { AccountDocument } from '../../models/index.js';
import { ApiError } from '../../middleware/error.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../../access/auth.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

export interface PublicAccount {
  id: string;
  email: string;
  createdAt: Date;
  lastLoginAt?: Date;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

export function toPublicAccount(account: AccountDocument): PublicAccount {
  return {
    id: account._id.toString(),
    email: account.email,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
  };
}

export async function registerAccount(input: RegisterInput): Promise<AccountDocument> {
  const email = input.email.trim().toLowerCase();
  const existing = await AccountModel.findOne({ email }).lean().exec();

  if (existing) {
    throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'Email is already registered.');
  }

  const passwordHash = await hashPassword(input.password);

  try {
    return await AccountModel.create({ email, passwordHash });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'Email is already registered.');
    }
    throw error;
  }
}

export async function loginAccount(input: LoginInput): Promise<AccountDocument> {
  const email = input.email.trim().toLowerCase();
  const account = await AccountModel.findOne({ email }).exec();

  // Always run a bcrypt comparison to reduce email-enumeration timing signals.
  const passwordHash = account?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPassword(input.password, passwordHash);

  if (!account || !passwordMatches) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  account.lastLoginAt = new Date();
  await account.save();

  return account;
}
