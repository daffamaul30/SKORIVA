import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ApiError, errorHandler, notFoundHandler } from '../src/middleware/error.js';

const WEB_ORIGIN = 'http://localhost:3000';

function createErrorProbeApp() {
  const app = express();

  app.get('/boom/api', () => {
    throw new ApiError(409, 'STATE_CONFLICT', 'The match state changed.');
  });
  app.get('/boom/unknown', () => {
    throw new Error('database down');
  });
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

describe('GET /health', () => {
  it('returns 200 with a minimal body', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('does not expose the x-powered-by header', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sends the explicit CORS origin, never a wildcard', async () => {
    const response = await request(createApp()).get('/health').set('Origin', WEB_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('error middleware', () => {
  it('returns { code, message } for unknown routes', async () => {
    const response = await request(createApp()).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: 'NOT_FOUND', message: 'Route not found.' });
  });

  it('returns { code, message } for a known ApiError', async () => {
    const response = await request(createErrorProbeApp()).get('/boom/api');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'STATE_CONFLICT',
      message: 'The match state changed.',
    });
  });

  it('hides internal error details behind INTERNAL_ERROR', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await request(createErrorProbeApp()).get('/boom/unknown');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
      });
      expect(JSON.stringify(response.body)).not.toContain('database down');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns a consistent body for malformed JSON', async () => {
    const response = await request(createApp())
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'INVALID_JSON',
      message: 'Request body is not valid JSON.',
    });
  });
});
