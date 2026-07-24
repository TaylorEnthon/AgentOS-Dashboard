/**
 * v1.20: vitest setup file — runs once per test file before any tests.
 *
 * Wires @testing-library/jest-dom matchers into the global `expect`
 * (toBeInTheDocument, toHaveTextContent, etc.) and stubs fetch with a
 * minimal in-memory mock so hook tests can avoid hitting the network.
 *
 * Each individual test file is responsible for replacing `globalThis.fetch`
 * with the response shape it needs; this file only installs the matcher
 * library and configures cleanup.
 */

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
});