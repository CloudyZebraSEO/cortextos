/**
 * Test runner env scrubbing.
 *
 * When tests run inside an active cortextOS agent shell, env vars like
 * CTX_AGENT_DIR and CTX_PROJECT_ROOT are inherited from the running agent.
 * Several test suites override CTX_FRAMEWORK_ROOT to a temp dir but do not
 * scrub the inherited paths, which trips the env-subordination canary in
 * src/utils/env.ts:resolveEnv() (added in commit fe39493). Result: tests
 * that pass on a clean CI shell explode inside a live agent session.
 *
 * Scrub these at vitest setup so tests start from a known-empty baseline.
 * Tests that legitimately want them (sprint7-environment.test.ts,
 * hooks.test.ts) already set them per-test.
 */
delete process.env.CTX_AGENT_DIR;
delete process.env.CTX_PROJECT_ROOT;
