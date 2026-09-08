import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests share one PostgreSQL database and truncate between
    // suites, so files must not run concurrently against it.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    sequence: { concurrent: false },
  },
});
