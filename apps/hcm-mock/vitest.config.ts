import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The store is per-process in-memory state, so suites must not interleave.
    fileParallelism: false,
  },
});
