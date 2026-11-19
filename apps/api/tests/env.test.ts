import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const MONGODB_URI = 'mongodb://127.0.0.1:27017/skoriva_test';
const TOKEN_PEPPER = 'test-pepper-0123456789abcdef0123456789';
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789';

describe('environment configuration', () => {
  it('applies development defaults around required secrets', () => {
    expect(parseEnv({ MONGODB_URI, TOKEN_PEPPER, JWT_SECRET })).toEqual({
      NODE_ENV: 'development',
      PORT: 4000,
      WEB_ORIGIN: 'http://localhost:3000',
      MONGODB_URI,
      TOKEN_PEPPER,
      JWT_SECRET,
    });
  });

  it('accepts explicit valid values', () => {
    expect(
      parseEnv({
        NODE_ENV: 'test',
        PORT: '5000',
        WEB_ORIGIN: 'https://skoriva.example',
        MONGODB_URI,
        TOKEN_PEPPER,
        JWT_SECRET,
      }),
    ).toEqual({
      NODE_ENV: 'test',
      PORT: 5000,
      WEB_ORIGIN: 'https://skoriva.example',
      MONGODB_URI,
      TOKEN_PEPPER,
      JWT_SECRET,
    });
  });

  it('requires MONGODB_URI', () => {
    expect(() => parseEnv({ TOKEN_PEPPER, JWT_SECRET })).toThrow(/MONGODB_URI/);
  });

  it('rejects a blank MONGODB_URI', () => {
    expect(() => parseEnv({ MONGODB_URI: '   ', TOKEN_PEPPER, JWT_SECRET })).toThrow(/MONGODB_URI/);
  });

  it('rejects a non-MongoDB URI scheme', () => {
    expect(() =>
      parseEnv({ MONGODB_URI: 'https://example.com/db', TOKEN_PEPPER, JWT_SECRET }),
    ).toThrow(/MONGODB_URI/);
  });

  it('accepts a mongodb+srv URI', () => {
    expect(
      parseEnv({
        MONGODB_URI: 'mongodb+srv://cluster.example/skoriva',
        TOKEN_PEPPER,
        JWT_SECRET,
      }).MONGODB_URI,
    ).toBe('mongodb+srv://cluster.example/skoriva');
  });

  it('requires TOKEN_PEPPER', () => {
    expect(() => parseEnv({ MONGODB_URI, JWT_SECRET })).toThrow(/TOKEN_PEPPER/);
  });

  it('rejects a TOKEN_PEPPER shorter than 32 characters', () => {
    expect(() => parseEnv({ MONGODB_URI, TOKEN_PEPPER: 'too-short', JWT_SECRET })).toThrow(
      /TOKEN_PEPPER/,
    );
  });

  it('requires JWT_SECRET', () => {
    expect(() => parseEnv({ MONGODB_URI, TOKEN_PEPPER })).toThrow(/JWT_SECRET/);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() => parseEnv({ MONGODB_URI, TOKEN_PEPPER, JWT_SECRET: 'too-short' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseEnv({ MONGODB_URI, TOKEN_PEPPER, JWT_SECRET, PORT: 'abc' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects out-of-range ports', () => {
    expect(() => parseEnv({ MONGODB_URI, TOKEN_PEPPER, JWT_SECRET, PORT: '0' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => parseEnv({ MONGODB_URI, TOKEN_PEPPER, JWT_SECRET, PORT: '70000' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects a fractional port', () => {
    expect(() => parseEnv({ MONGODB_URI, TOKEN_PEPPER, JWT_SECRET, PORT: '4000.5' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects an invalid web origin', () => {
    expect(() =>
      parseEnv({ MONGODB_URI, TOKEN_PEPPER, JWT_SECRET, WEB_ORIGIN: 'not-a-url' }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('rejects an unknown node environment', () => {
    expect(() => parseEnv({ MONGODB_URI, TOKEN_PEPPER, JWT_SECRET, NODE_ENV: 'staging' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
