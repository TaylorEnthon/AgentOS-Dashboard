/**
 * v1.20: vitest configuration — frontend unit + integration tests.
 *
 * Shares vite.config.ts plugins and aliases so the test environment
 * resolves the same way the dev server does (`@/*` → src/*, etc.).
 *
 * Environment is jsdom because most of what we test is React component
 * behaviour (render / user-event / state changes). Pure-utility tests
 * can still run here without paying the jsdom cost — vitest only
 * bootstraps jsdom once per file.
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Co-located with source: `src/foo/foo.test.ts` runs alongside `src/foo/foo.ts`.
  },
});