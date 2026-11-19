import { Router } from 'express';
import type { ZodType } from 'zod';
import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error.js';
import {
  clearAuthCookie,
  requireAccount,
  setAuthCookie,
  signAccountToken,
} from '../../access/auth.js';
import { loginSchema, registerSchema } from './auth.schemas.js';
import { loginAccount, registerAccount, toPublicAccount } from './auth.service.js';

export const authRouter = Router();

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);

  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new ApiError(400, 'VALIDATION_ERROR', message);
  }

  return result.data;
}

authRouter.post('/register', async (request, response) => {
  const input = parseBody(registerSchema, request.body);
  const account = await registerAccount(input);

  response.status(201).json(toPublicAccount(account));
});

authRouter.post('/login', async (request, response) => {
  const input = parseBody(loginSchema, request.body);
  const account = await loginAccount(input);
  const token = signAccountToken(account._id.toString(), env.JWT_SECRET);

  setAuthCookie(response, token);
  response.status(200).json(toPublicAccount(account));
});

authRouter.post('/logout', (_request, response) => {
  clearAuthCookie(response);
  response.status(204).send();
});

authRouter.get('/me', requireAccount, (request, response) => {
  if (!request.account) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.');
  }

  response.status(200).json(toPublicAccount(request.account));
});
