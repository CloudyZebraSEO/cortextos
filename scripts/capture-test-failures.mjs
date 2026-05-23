#!/usr/bin/env node
/**
 * scripts/capture-test-failures.mjs
 *
 * Runs the full vitest suite via the JSON reporter and, on a non-zero exit,
 * dumps a concise list of the FAILED test files + test names + first error line
 * to stdout AND a timestamped log under test-results/ (gitignored). Exits with
 * vitest's own status code (CI-safe).
 *
 * Purpose: the full suite flakes only under heavy machine CPU contention (the
 * live fleet loading the box) — it can't be reproduced in a quiet window. This
 * wrapper makes the NEXT real loaded flake capture the exact flaky test
 * identities for free, so they can be hardened surgically (the fast-checker /
 * perf playbook: remove wall-clock / fake-time-advance sensitivity).
 *
 * Usage:  node scripts/capture-test-failures.mjs [extra vitest args]
 *         npm run test:capture
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'test-results'; // already in .gitignore
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const jsonPath = join(OUT_DIR, 'vitest-results.json');

// Pass through any extra CLI args (e.g. a specific file, --maxWorkers, etc.).
const extra = process.argv.slice(2);
const run = spawnSync(
  'npx',
  ['vitest', 'run', '--reporter=json', `--outputFile=${jsonPath}`, ...extra],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

const code = run.status ?? 1;
if (code === 0) {
  console.log('\n[capture] all tests passed — no failures to record.');
  process.exit(0);
}

// Parse the JSON result for failed assertions.
let report;
try {
  report = JSON.parse(readFileSync(jsonPath, 'utf-8'));
} catch {
  console.error(`\n[capture] tests failed (exit ${code}) but could not read ${jsonPath} — re-run with the json reporter to capture details.`);
  process.exit(code);
}

const failed = [];
for (const file of report.testResults ?? []) {
  for (const a of file.assertionResults ?? []) {
    if (a.status === 'failed') {
      failed.push({
        file: file.name,
        test: a.fullName || a.title,
        msg: (a.failureMessages ?? []).join(' | ').split('\n')[0].slice(0, 300),
      });
    }
  }
}

const files = [...new Set(failed.map((f) => f.file))];
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = join(OUT_DIR, `failures-${ts}.log`);
const lines = [
  `# Vitest failures — ${new Date().toISOString()} (vitest exit ${code})`,
  `# ${failed.length} failed test(s) across ${files.length} file(s)`,
  '# Likely contention-flaky if these pass on isolated re-run (see flaky-hardening backlog).',
  '',
  ...failed.map((f) => `FAIL  ${f.file}\n      › ${f.test}\n      ${f.msg}\n`),
];
writeFileSync(logPath, lines.join('\n'));

console.error(`\n[capture] ${failed.length} FAILED across ${files.length} file(s) — details → ${logPath}`);
console.error('[capture] failing files:');
console.error(files.map((f) => `  - ${f}`).join('\n'));
process.exit(code);
