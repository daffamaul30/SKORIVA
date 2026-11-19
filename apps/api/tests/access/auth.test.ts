import { describe, expect, it } from 'vitest';
import {
  AUTH_COOKIE_NAME,
  BCRYPT_COST,
  JWT_TTL_SECONDS,
  MAX_PASSWORD_BYTES,
  getAuthCookieOptions,
  hashPassword,
  signAccountToken,
  verifyAccountToken,
  verifyPassword,
} from '../../src/access/auth.js';
import { ApiError } from '../../src/middleware/error.js';
import { registerSchema } from '../../src/modules/auth/auth.schemas.js';

const ACCOUNT_ID = '507f1f77bcf86cd799439011';

describe('password hashing', () => {
  it('hashes with bcrypt cost 12 and verifies correctly', async () => {
    const password = 'correct horse battery staple';
    const passwordHash = await hashPassword(password);

    expect(passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(passwordHash).not.toContain(password);
    expect(await verifyPassword(password, passwordHash)).toBe(true);
    expect(await verifyPassword('wrong password', passwordHash)).toBe(false);
  });

  it('uses the documented bcrypt cost', () => {
    expect(BCRYPT_COST).toBe(12);
  });
});

describe('JWT account token', () => {
  it('signs and verifies the account subject', () => {
    const token = signAccountToken(ACCOUNT_ID);

    expect(verifyAccountToken(token)).toBe(ACCOUNT_ID);
  });

  it('rejects an invalid token', () => {
    expect(() => verifyAccountToken('not-a-jwt')).toThrow(ApiError);
  });

  it('rejects a token signed with another secret', () => {
    const token = signAccountToken(ACCOUNT_ID, 'another-secret-0123456789abcdef012345');

    expect(() => verifyAccountToken(token)).toThrow(ApiError);
  });
});

describe('auth cookie options', () => {
  it('uses the agreed cookie settings', () => {
    const options = getAuthCookieOptions();

    expect(AUTH_COOKIE_NAME).toBe('skoriva_session');
    expect(JWT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(JWT_TTL_SECONDS * 1000);
    expect(options.secure).toBe(false);
  });
});

describe('password validation', () => {
  const email = 'user@example.com';

  it('accepts a password of exactly 72 UTF-8 bytes', () => {
    const password = 'a'.repeat(MAX_PASSWORD_BYTES);

    expect(registerSchema.safeParse({ email, password }).success).toBe(true);
  });

  it('rejects a password over 72 UTF-8 bytes', () => {
    const password = 'a'.repeat(MAX_PASSWORD_BYTES + 1);

    expect(registerSchema.safeParse({ email, password }).success).toBe(false);
  });

  it('rejects multibyte passwords over 72 UTF-8 bytes', () => {
    const password = 'é'.repeat(37); // 74 UTF-8 bytes

    expect(Buffer.byteLength(password, 'utf8')).toBeGreaterThan(MAX_PASSWORD_BYTES);
    expect(registerSchema.safeParse({ email, password }).success).toBe(false);
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(registerSchema.safeParse({ email, password: 'short' }).success).toBe(false);
  });

  it('rejects passwords longer than 128 characters', () => {
    expect(registerSchema.safeParse({ email, password: 'a'.repeat(129) }).success).toBe(false);
  });

  it('rejects an email longer than 254 characters', () => {
    const longEmail = `${'a'.repeat(250)}@example.com`;

    expect(registerSchema.safeParse({ email: longEmail, password: 'password123' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields', () => {
    expect(
      registerSchema.safeParse({ email, password: 'password123', role: 'admin' }).success,
    ).toBe(false);
  });
});
