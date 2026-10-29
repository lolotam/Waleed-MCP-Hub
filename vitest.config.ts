import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  // SDK-loaded workers and Windows process-host compilation are memory-heavy.
  // Serialize Windows crypto/process-host fixtures instead of changing runtime
  // deadlines or skipping containment/cleanup assertions.
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    maxWorkers: process.platform === 'win32' ? 1 : 2,
  },
});
