import { defineConfig } from 'vitest/config';

// Requires local private content and editorial receipts. Missing inputs fail;
// passing this suite does not grant human approval or publish any revision.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.content.test.ts'],
    restoreMocks: true,
    testTimeout: 20_000,
  },
});
