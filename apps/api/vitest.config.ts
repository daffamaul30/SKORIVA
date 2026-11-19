import { defineConfig } from 'vitest/config';

const TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/skoriva_test';
const TEST_TOKEN_PEPPER = 'test-pepper-0123456789abcdef0123456789';
const TEST_JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: {
      MONGODB_URI: TEST_MONGODB_URI,
      TOKEN_PEPPER: TEST_TOKEN_PEPPER,
      JWT_SECRET: TEST_JWT_SECRET,
    },
    // The MongoDB smoke test may need to download the 7.0.14 binary once.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
