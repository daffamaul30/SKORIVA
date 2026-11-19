import cookieParser from 'cookie-parser';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app.js';
import { requireAccount } from '../../../src/access/auth.js';
import { errorHandler } from '../../../src/middleware/error.js';
import { AccountModel } from '../../../src/models/index.js';

const WEB_ORIGIN = 'http://localhost:3000';
const PASSWORD = 'password123';

let mongod: MongoMemoryServer | undefined;

function getSetCookie(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const cookie = Array.isArray(header) ? header[0] : header;

  if (!cookie) throw new Error('Expected a Set-Cookie header.');
  return cookie;
}

async function register(email: string, password = PASSWORD) {
  return request(createApp()).post('/api/auth/register').send({ email, password });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t10_auth'));
  await AccountModel.syncIndexes();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
});

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('POST /api/auth/register', () => {
  it('registers an account and stores only a bcrypt hash', async () => {
    const response = await register('user@example.com');

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      email: 'user@example.com',
      createdAt: expect.any(String),
    });
    expect(response.body).not.toHaveProperty('passwordHash');

    const account = await AccountModel.findOne({ email: 'user@example.com' }).lean().exec();
    expect(account?.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(account?.passwordHash).not.toContain(PASSWORD);
  });

  it('rejects a duplicate email', async () => {
    await register('duplicate@example.com');

    const response = await register('duplicate@example.com');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'EMAIL_ALREADY_REGISTERED',
      message: 'Email is already registered.',
    });
  });

  it('rejects invalid email and short password', async () => {
    const invalidEmail = await register('not-an-email');
    const shortPassword = await register('short@example.com', 'short');

    expect(invalidEmail.status).toBe(400);
    expect(invalidEmail.body.code).toBe('VALIDATION_ERROR');
    expect(shortPassword.status).toBe(400);
    expect(shortPassword.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a password over 72 UTF-8 bytes', async () => {
    const response = await register('long@example.com', 'a'.repeat(73));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a password of exactly 72 UTF-8 bytes', async () => {
    const response = await register('exact@example.com', 'a'.repeat(72));

    expect(response.status).toBe(201);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in, sets an httpOnly cookie, and updates lastLoginAt', async () => {
    await register('login@example.com');
    const agent = request.agent(createApp());

    const response = await agent
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: expect.any(String),
      email: 'login@example.com',
      createdAt: expect.any(String),
      lastLoginAt: expect.any(String),
    });

    const cookie = getSetCookie(response);
    expect(cookie).toContain('skoriva_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800');

    const account = await AccountModel.findOne({ email: 'login@example.com' }).lean().exec();
    expect(account?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('rejects a wrong password with a generic message', async () => {
    await register('wrong@example.com');

    const response = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'wrong@example.com', password: 'wrong-password' });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password.',
    });
  });

  it('uses the same error for an unknown email', async () => {
    const response = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'missing@example.com', password: PASSWORD });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password.',
    });
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current account without internal fields', async () => {
    await register('me@example.com');
    const agent = request.agent(createApp());
    await agent.post('/api/auth/login').send({ email: 'me@example.com', password: PASSWORD });

    const response = await agent.get('/api/auth/me');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: expect.any(String),
      email: 'me@example.com',
      createdAt: expect.any(String),
      lastLoginAt: expect.any(String),
    });
    expect(response.body).not.toHaveProperty('passwordHash');
  });

  it('rejects a request without a cookie', async () => {
    const response = await request(createApp()).get('/api/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an invalid cookie', async () => {
    const response = await request(createApp())
      .get('/api/auth/me')
      .set('Cookie', 'skoriva_session=invalid');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie and invalidates the session', async () => {
    await register('logout@example.com');
    const agent = request.agent(createApp());
    await agent.post('/api/auth/login').send({ email: 'logout@example.com', password: PASSWORD });

    const logout = await agent.post('/api/auth/logout');
    const cookie = getSetCookie(logout);

    expect(logout.status).toBe(204);
    expect(cookie).toContain('skoriva_session=;');
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('is idempotent without a cookie', async () => {
    const response = await request(createApp()).post('/api/auth/logout');

    expect(response.status).toBe(204);
  });
});

describe('Origin and CORS protection', () => {
  it('rejects a state-changing request from an untrusted origin', async () => {
    const response = await request(createApp())
      .post('/api/auth/login')
      .set('Origin', 'http://evil.example')
      .send({ email: 'user@example.com', password: PASSWORD });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('UNTRUSTED_ORIGIN');
  });

  it('accepts the configured origin and requests without Origin', async () => {
    await register('origin@example.com');

    const allowed = await request(createApp())
      .post('/api/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'origin@example.com', password: PASSWORD });
    const noOrigin = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'origin@example.com', password: PASSWORD });

    expect(allowed.status).toBe(200);
    expect(noOrigin.status).toBe(200);
  });

  it('answers CORS preflight with the explicit origin and credentials', async () => {
    const response = await request(createApp())
      .options('/api/auth/login')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('requireAccount middleware', () => {
  function createProbeApp() {
    const app = express();
    app.use(cookieParser());
    app.get('/protected', requireAccount, (request, response) => {
      response.status(200).json({ id: request.account?._id.toString() });
    });
    app.use(errorHandler);
    return app;
  }

  it('rejects a request without a valid account cookie', async () => {
    const response = await request(createProbeApp()).get('/protected');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('accepts a valid account cookie', async () => {
    await register('probe@example.com');
    const login = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'probe@example.com', password: PASSWORD });
    const cookie = getSetCookie(login);

    const response = await request(createProbeApp()).get('/protected').set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.id).toEqual(expect.any(String));
  });
});
