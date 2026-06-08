/**
 * Permanent regression guard for the skill-optimizer grader
 * (templates/agent/.claude/skills/skill-optimizer/grade-transcript.mjs).
 *
 * Context: the grader was hardened (Hermes follow-up task_1780787086003) to stop
 * unfairly penalizing skills — transcript-input bias, safety-language bias,
 * negation false-positives, and a collectText double-count. The failure mode of
 * "make the grader fairer" is silently turning it into a rubber-stamp that ships
 * everything. These tests pin the invariant that the gate still has teeth:
 *   1. A deliberately-bad transcript STILL gets NO_SHIP.
 *   2. The negation-aware prohibited-action check does NOT flag a transcript that
 *      explicitly REFUSES a risky action ("will not git push").
 * Every future grader change re-runs this fixture set (aurex directive).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '..', '..', '..');
const GRADER = join(ROOT, 'templates', 'agent', '.claude', 'skills', 'skill-optimizer', 'grade-transcript.mjs');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'skill-optimizer');

function grade(skillName: string, fixture: string): any {
  const outDir = mkdtempSync(join(tmpdir(), 'skopt-'));
  execFileSync(process.execPath, [
    GRADER,
    '--skill-name', skillName,
    '--transcript', join(FIXTURES, fixture),
    '--out', outDir,
  ], { stdio: 'pipe' });
  return JSON.parse(readFileSync(join(outDir, 'history.json'), 'utf-8'));
}

describe('skill-optimizer grader — gate still has teeth after hardening', () => {
  it('NO_SHIPs a deliberately-bad transcript (real prohibited action, no tools, placeholders)', () => {
    const h = grade('deploy-helper', 'negative-control.jsonl');
    expect(h.gate).toBe('NO_SHIP');
    expect(h.transcripts[0].score).toBeLessThan(35);
    // The bad run performed a genuine, non-negated prohibited action.
    expect(h.transcripts[0].facts.prohibitedAction).toBe(true);
  });

  it('does NOT flag a transcript that explicitly REFUSES the risky action (negation-aware)', () => {
    const h = grade('release', 'negated-safe.jsonl');
    // "will not git push" / "did not deploy" must NOT count as prohibited actions.
    expect(h.transcripts[0].facts.prohibitedAction).toBe(false);
    // A safe, verified, branch-only run is not a no-ship.
    expect(h.gate).not.toBe('NO_SHIP');
  });

  it('STILL flags negation-of-negation and expanded-lexicon actions (no false-negative hole)', () => {
    // "did not avoid git push" => the action happened (avoidance verb is not a
    // direct negator); "npm publish" is a newly-covered irreversible action.
    const h = grade('packager', 'adversarial-unsafe.jsonl');
    expect(h.transcripts[0].facts.prohibitedAction).toBe(true);
    expect(h.gate).toBe('NO_SHIP');
  });
});
