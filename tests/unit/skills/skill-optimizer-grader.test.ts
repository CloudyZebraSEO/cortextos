/**
 * Permanent regression guard for the skill-optimizer grader
 * (templates/agent/.claude/skills/skill-optimizer/grade-transcript.mjs).
 *
 * Context: the grader was hardened (Hermes follow-up task_1780787086003) to stop
 * unfairly penalizing skills — transcript-input bias, safety-language bias,
 * negation false-positives, and a collectText double-count. The failure mode of
 * "make the grader fairer" is silently turning it into a rubber-stamp that ships
 * everything. These tests pin the invariant that the gate still has teeth:
 *   1. A deliberately-bad transcript (real destructive COMMAND invoked) STILL gets NO_SHIP.
 *   2. A transcript that explicitly REFUSES a risky action (no destructive command
 *      invoked) is NOT flagged.
 *   3. (task_1781606939353) A run that only DISCUSSES a deploy/merge in prose or a
 *      message body — without invoking a destructive command — is NOT flagged
 *      (dim-5 now gates on real tool-call command params, not transcript prose),
 *      and a placeholder inside a quoted/template string is NOT counted as an
 *      unresolved output placeholder (dim-4 strips quoted/code spans first).
 * Every future grader change re-runs this fixture set (aurex directive).
 */
import { describe, it, expect } from 'vitest';
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
  it('NO_SHIPs a run that INVOKES a real destructive command (git push && npm publish) + leaves a bare placeholder', () => {
    const h = grade('deploy-helper', 'negative-control.jsonl');
    expect(h.gate).toBe('NO_SHIP');
    expect(h.transcripts[0].score).toBeLessThan(35);
    // dim-5: a real destructive command in tool-call params IS flagged.
    expect(h.transcripts[0].facts.prohibitedAction).toBe(true);
    // dim-4: a bare unresolved TODO (not quoted/templated) IS flagged.
    expect(h.transcripts[0].facts.unresolvedPlaceholders).toBe(true);
  });

  it('does NOT flag a transcript that refuses the risky action and only runs a benign command', () => {
    const h = grade('release', 'negated-safe.jsonl');
    // Only `npm test` was invoked — no destructive command, so not flagged.
    expect(h.transcripts[0].facts.prohibitedAction).toBe(false);
    expect(h.gate).not.toBe('NO_SHIP');
  });

  it('task_1781606939353: does NOT flag a run that only DISCUSSES a deploy in prose/message-body, nor a quoted/template placeholder', () => {
    const h = grade('heartbeat', 'discuss-not-do.jsonl');
    // dim-5: "deployed"/"merged to main" appear only in assistant prose and a
    // send-telegram message body — no destructive command was invoked — so the
    // run must NOT be flagged (the reported false-positive: a heartbeat during a
    // deploy session was scoring 37/50 REVIEW_REQUIRED).
    expect(h.transcripts[0].facts.prohibitedAction).toBe(false);
    // dim-4: the only placeholder ("## TODO") is inside a quoted/template span,
    // so it must NOT count as an unresolved output placeholder.
    expect(h.transcripts[0].facts.unresolvedPlaceholders).toBe(false);
    // A clean operational run is not a no-ship.
    expect(h.gate).not.toBe('NO_SHIP');
  });
});
