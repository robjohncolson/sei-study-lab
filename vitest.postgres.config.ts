import { defineConfig } from 'vitest/config';

// Explicit opt-in: default tests never create or connect to a Postgres database.
export default defineConfig({
  test: {
    include: ['apps/server/postgres/*.pg.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
