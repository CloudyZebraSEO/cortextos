import { defineConfig } from 'vitest/config';
import path from 'path';

// Isolated perf-integration config. The heavy perf files (phase4/phase5) are
// gated behind PERF=1 (describe.skipIf) so the DEFAULT `vitest run` skips them
// for a deterministic, fast suite. This config is the dedicated perf job:
//   npm run test:perf
// It sets PERF=1, runs ONLY the two perf files, and disables file parallelism
// so they don't contend with EACH OTHER (inter-file CPU contention inflates the
// latency budgets — sequential = clean isolated signal). Cross-platform by
// construction (no shell env-var prefix). Mirrors vitest.config.ts's alias +
// setup so the dashboard route imports + env setup resolve.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'dashboard/src'),
      'next/server': path.resolve(import.meta.dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    setupFiles: ['./tests/setup-env.ts'],
    // Heavy 1000-cron probes + fake-time advances legitimately take longer than
    // the default suite's 10s; generous in isolation (no contention to inflate).
    testTimeout: 120000,
    // Run the perf files one at a time so they don't contend with each other.
    fileParallelism: false,
    // Opens the PERF=1 gate in the test files (process.env.PERF). No shell prefix
    // needed → works on Windows cmd, PowerShell, and POSIX shells alike.
    env: { PERF: '1' },
    include: [
      'tests/integration/phase4-performance.test.ts',
      'tests/integration/phase5-performance.test.ts',
    ],
  },
});
