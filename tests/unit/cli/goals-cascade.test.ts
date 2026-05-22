/**
 * tests/unit/cli/goals-cascade.test.ts
 *
 * Covers the 7 spec test cases for `cortextos goals cascade`
 * (orgs/aunnix/agents/oracle/proposals/cycle-15-h1/goals-cascade-command-spec.md):
 * happy path, omitted-agent fail, unknown agent, missing goals, dry-run,
 * idempotent re-run, and atomicity / zero-writes-on-failure.
 *
 * Tests runCascade() directly (the process.exit-free core) against a temp
 * framework root, so exit codes + on-disk state are asserted without spawning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCascade } from '../../../src/cli/goals';

const ORG = 'testorg';
let root: string;

function agentDir(name: string): string { return join(root, 'orgs', ORG, 'agents', name); }

/** Create a roster agent (IDENTITY.md makes it count). Optionally seed a stale goals.json + GOALS.md. */
function addAgent(name: string, stale = false): void {
  const d = agentDir(name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'IDENTITY.md'), `# ${name}\n`);
  if (stale) {
    writeFileSync(join(d, 'goals.json'), JSON.stringify({ focus: 'old', goals: ['old'], updated_at: '2020-01-01T00:00:00Z', updated_by: 'seed' }));
    writeFileSync(join(d, 'GOALS.md'), '# Goals\n(old)\n');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(d, 'goals.json'), old, old);
    utimesSync(join(d, 'GOALS.md'), old, old);
  }
}

function writeStaging(obj: unknown): string {
  const p = join(root, 'staging.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

function happyStaging(agents: string[]): unknown {
  const a: Record<string, unknown> = {};
  for (const n of agents) a[n] = { focus: `focus ${n}`, goals: [`g1 ${n}`, `g2 ${n}`], bottleneck: '' };
  return { daily_focus: 'ship the thing today', agents: a };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortextos-cascade-'));
  mkdirSync(join(root, 'orgs', ORG), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('goals cascade — runCascade', () => {
  it('1. happy path: all roster agents staged → written, regen, verify all-fresh, exit 0', () => {
    const roster = ['aurex', 'oracle', 'codex'];
    roster.forEach((n) => addAgent(n));
    const input = writeStaging(happyStaging(roster));

    const r = runCascade(root, { input, org: ORG });
    expect(r.exitCode).toBe(0);
    expect(r.out.join('\n')).toMatch(/verified all fresh/);
    // every agent's goals.json written with updated_by cascade + GOALS.md regen
    for (const n of roster) {
      const gj = JSON.parse(readFileSync(join(agentDir(n), 'goals.json'), 'utf-8'));
      expect(gj.updated_by).toBe('cascade');
      expect(gj.focus).toBe(`focus ${n}`);
      expect(existsSync(join(agentDir(n), 'GOALS.md'))).toBe(true);
    }
    // org daily_focus written
    const org = JSON.parse(readFileSync(join(root, 'orgs', ORG, 'goals.json'), 'utf-8'));
    expect(org.daily_focus).toBe('ship the thing today');
    expect(typeof org.daily_focus_set_at).toBe('string');
  });

  it('2. omitted agent → exit non-zero, names the omitted as stale (whole-roster verify)', () => {
    addAgent('aurex'); addAgent('oracle'); addAgent('codex', /* stale */ true);
    const input = writeStaging(happyStaging(['aurex', 'oracle'])); // omits codex

    const r = runCascade(root, { input, org: ORG });
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/FAILED — stale:/);
    expect(r.err.join('\n')).toContain('codex');
  });

  it('3. unknown agent in staging → validation fail, exit 1, ZERO writes', () => {
    addAgent('aurex');
    // pre-existing org goals.json to prove it is untouched
    const orgPath = join(root, 'orgs', ORG, 'goals.json');
    writeFileSync(orgPath, JSON.stringify({ daily_focus: 'previous', sentinel: 1 }));
    const before = readFileSync(orgPath, 'utf-8');
    const input = writeStaging({ daily_focus: 'x', agents: { ghost: { focus: 'f', goals: ['g'] } } });

    const r = runCascade(root, { input, org: ORG });
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/unknown agent in staging: 'ghost'/);
    expect(readFileSync(orgPath, 'utf-8')).toBe(before); // untouched
  });

  it('4. missing goals[] for an agent → validation fail, exit 1, zero writes', () => {
    addAgent('aurex');
    const orgPath = join(root, 'orgs', ORG, 'goals.json');
    expect(existsSync(orgPath)).toBe(false);
    const input = writeStaging({ daily_focus: 'x', agents: { aurex: { focus: 'f' } } }); // no goals

    const r = runCascade(root, { input, org: ORG });
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/non-empty 'goals' array required/);
    expect(existsSync(orgPath)).toBe(false); // no org file created
  });

  it('5. --dry-run → plan printed, exit 0, NO file mtimes change', () => {
    const roster = ['aurex', 'oracle'];
    roster.forEach((n) => addAgent(n, /* stale-but-present */ true));
    const mtimes = roster.map((n) => statSync(join(agentDir(n), 'goals.json')).mtimeMs);
    const input = writeStaging(happyStaging(roster));

    const r = runCascade(root, { input, org: ORG, dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(r.out.join('\n')).toMatch(/\[dry-run\]/);
    expect(r.out.join('\n')).toMatch(/no files written/);
    roster.forEach((n, i) => {
      expect(statSync(join(agentDir(n), 'goals.json')).mtimeMs).toBe(mtimes[i]); // unchanged
    });
  });

  it('6. re-run immediately → idempotent, still exit 0', () => {
    const roster = ['aurex', 'oracle', 'codex'];
    roster.forEach((n) => addAgent(n));
    const input = writeStaging(happyStaging(roster));

    expect(runCascade(root, { input, org: ORG }).exitCode).toBe(0);
    const r2 = runCascade(root, { input, org: ORG });
    expect(r2.exitCode).toBe(0);
    expect(r2.out.join('\n')).toMatch(/verified all fresh/);
  });

  it('7. atomicity: a failed cascade leaves pre-existing goals.json intact + valid (no partial/corrupt)', () => {
    addAgent('aurex');
    // seed a valid pre-existing agent goals.json
    const gjPath = join(agentDir('aurex'), 'goals.json');
    const seeded = JSON.stringify({ focus: 'keep me', goals: ['intact'], updated_at: '2026-05-22T00:00:00Z', updated_by: 'seed' });
    writeFileSync(gjPath, seeded);
    // staging fails validation (unknown agent) AFTER the file exists
    const input = writeStaging({ daily_focus: 'x', agents: { ghost: { focus: 'f', goals: ['g'] }, aurex: { focus: 'f', goals: ['g'] } } });

    const r = runCascade(root, { input, org: ORG });
    expect(r.exitCode).toBe(1);
    // pre-existing file untouched + still valid JSON (never half-written)
    expect(readFileSync(gjPath, 'utf-8')).toBe(seeded);
    expect(() => JSON.parse(readFileSync(gjPath, 'utf-8'))).not.toThrow();
  });
});
