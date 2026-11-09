import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['tests/**/*.test.ts','apps/server/**/*.test.ts'],exclude:['apps/server/postgres/**'],testTimeout:15000}});
