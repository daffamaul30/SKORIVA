/**
 * Health endpoint (T-04).
 *
 * Intentionally unauthenticated and dependency-free: it only reports that the
 * HTTP process is alive. Database readiness is added by T-06.
 */

import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (_request, response) => {
  response.status(200).json({ status: 'ok' });
});
