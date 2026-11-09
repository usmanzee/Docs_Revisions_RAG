import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Pins the clock. See tests/setup.ts - this domain is almost entirely
    // date arithmetic relative to "now".
    setupFiles: ['tests/setup.ts'],
    // The store is per-process in-memory state, so suites must not interleave.
    fileParallelism: false,
  },
});
