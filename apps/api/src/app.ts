/**
 * Express application factory.
 *
 * T-04: HTTP foundation.
 * T-10: cookie parsing, trusted-origin guard, and account auth routes.
 */

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { env, type Env } from './config/env.js';
import { domainErrorHandler } from './middleware/domain-errors.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requireTrustedOrigin } from './middleware/origin.js';
import { authRouter } from './modules/auth/index.js';
import { eventRouter } from './modules/event/index.js';
import { healthRouter } from './modules/health/health.router.js';
import { matchRouter } from './modules/match/index.js';

export interface CreateAppOptions {
  webOrigin?: Env['WEB_ORIGIN'];
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const webOrigin = options.webOrigin ?? env.WEB_ORIGIN;

  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    // R-03: never leak the viewer URL (which may contain `?code=`) via Referer.
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(
    cors({
      origin: webOrigin,
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json());
  app.use(requireTrustedOrigin(webOrigin));

  app.use(healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/matches', matchRouter);
  app.use('/api/events', eventRouter);

  app.use(notFoundHandler);
  app.use(domainErrorHandler);
  app.use(errorHandler);

  return app;
}
