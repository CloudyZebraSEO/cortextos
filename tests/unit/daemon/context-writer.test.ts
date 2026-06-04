/**
 * Unit coverage for the daemon-side context-status writer (Phase-2 auto-handoff fix).
 *
 * The two CRITICAL tests are hard gates (they guard failure modes that would regress
 * WORSE than the bug being fixed):
 *   #1 CAP SOURCE        — cap is reused from statusLine, never inferred. A wrong cap
 *                          flips 70% ↔ 14% = false/missed restarts fleet-wide.
 *   #2 POST-RESTART      — a previous session's transcript must never clobber the
 *      CLOBBER             zero-reset after a force-restart (the restart-loop).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  writeContextStatusFromTranscript,
  claudeProjectDir,
  CTX_STALE_GATE_MS,
} from '../../../src/daemon/context-writer';

const NOW = 1_900_000_000_000; // fixed clock

let root: string;
let stateDir: string;
let projDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxw-'));
  stateDir = join(root, 'state');
  projDir = join(root, 'proj');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a transcript file with one assistant usage record; set its mtime. */
function writeTranscript(
  sessionId: string,
  usage: Record<string, number>,
  mtimeMs: number,
): void {
  const p = join(projDir, `${sessionId}.jsonl`);
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(mtimeMs).toISOString(),
    message: { model: 'claude-opus-4-8', usage },
  });
  writeFileSync(p, line + '\n');
  const secs = mtimeMs / 1000;
  utimesSync(p, secs, secs);
}

/** Write context_status.json (the statusLine-written file the writer reads cap/age from). */
function writeStatus(obj: Record<string, unknown>): void {
  writeFileSync(join(stateDir, 'context_status.json'), JSON.stringify(obj));
}

function readStatus(): any {
  return JSON.parse(readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
}

const STALE = NOW - (CTX_STALE_GATE_MS + 60_000); // a comfortably-stale statusLine written_at

describe('writeContextStatusFromTranscript', () => {
  // ── CRITICAL #1 — cap source ─────────────────────────────────────────────
  describe('CRITICAL #1: cap is sourced from statusLine, never guessed', () => {
    it('1M cap + 170k used → ~17% (does NOT cross a handoff threshold)', () => {
      writeStatus({ context_window_size: 1_000_000, written_at: new Date(STALE).toISOString() });
      writeTranscript('sess-1m', { input_tokens: 0, cache_read_input_tokens: 170_000, cache_creation_input_tokens: 0, output_tokens: 9999 }, NOW - 5_000);
      const r = writeContextStatusFromTranscript({ launchDir: 'x', stateDir, transcriptDir: projDir, sessionStartMs: NOW - 60_000, now: NOW });
      expect(r).toBe('written');
      expect(readStatus().used_percentage).toBeCloseTo(17, 0);
    });

    it('SAME 170k used + 200k cap → 85% (cap, not tokens, decides) ', () => {
      writeStatus({ context_window_size: 200_000, written_at: new Date(STALE).toISOString() });
      writeTranscript('sess-200k', { input_tokens: 0, cache_read_input_tokens: 170_000, cache_creation_input_tokens: 0, output_tokens: 0 }, NOW - 5_000);
      const r = writeContextStatusFromTranscript({ launchDir: 'x', stateDir, transcriptDir: projDir, sessionStartMs: NOW - 60_000, now: NOW });
      expect(r).toBe('written');
      expect(readStatus().used_percentage).toBeCloseTo(85, 0);
    });

    it('cap ABSENT → skip-no-cap (never guesses a cap, writes nothing)', () => {
      writeStatus({ written_at: new Date(STALE).toISOString() }); // no context_window_size
      writeTranscript('sess-x', { input_tokens: 0, cache_read_input_tokens: 170_000, cache_creation_input_tokens: 0, output_tokens: 0 }, NOW - 5_000);
      const before = readStatus();
      const r = writeContextStatusFromTranscript({ launchDir: 'x', stateDir, transcriptDir: projDir, sessionStartMs: NOW - 60_000, now: NOW });
      expect(r).toBe('skip-no-cap');
      expect(readStatus()).toEqual(before); // untouched
    });
  });

  // ── CRITICAL #2 — post-restart clobber / restart-loop ────────────────────
  describe('CRITICAL #2: a previous session transcript never clobbers the zero-reset', () => {
    it('newest transcript older than session start → skip-prev-session (reset preserved)', () => {
      // Simulate post-force-restart: context_status.json was reset to 0; the only
      // transcript is the PREVIOUS session, older than the new session start.
      const resetWrittenAt = NOW - (CTX_STALE_GATE_MS + 1); // stale enough to pass the gate
      writeStatus({ used_percentage: 0, context_window_size: 1_000_000, written_at: new Date(resetWrittenAt).toISOString() });
      const sessionStartMs = NOW - 30_000;
      writeTranscript('old-session', { input_tokens: 0, cache_read_input_tokens: 950_000, cache_creation_input_tokens: 0, output_tokens: 0 }, sessionStartMs - 120_000); // 2min BEFORE session start
      const r = writeContextStatusFromTranscript({ launchDir: 'x', stateDir, transcriptDir: projDir, sessionStartMs, now: NOW });
      expect(r).toBe('skip-prev-session');
      expect(readStatus().used_percentage).toBe(0); // the 95% old session did NOT clobber it
    });

    it('new-session transcript (mtime > session start) → written with its filename session_id', () => {
      writeStatus({ used_percentage: 0, context_window_size: 1_000_000, written_at: new Date(NOW - (CTX_STALE_GATE_MS + 1)).toISOString() });
      const sessionStartMs = NOW - 30_000;
      writeTranscript('fresh-session', { input_tokens: 5, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0, output_tokens: 0 }, NOW - 5_000); // AFTER session start
      const r = writeContextStatusFromTranscript({ launchDir: 'x', stateDir, transcriptDir: projDir, sessionStartMs, now: NOW });
      expect(r).toBe('written');
      const s = readStatus();
      expect(s.session_id).toBe('fresh-session');
      expect(s.used_percentage).toBeCloseTo(30.0005, 1);
    });
  });

  // ── stale gate ───────────────────────────────────────────────────────────
  it('statusLine fresh (age < 2min) → skip-fresh-statusline (statusLine authoritative)', () => {
    writeStatus({ used_percentage: 40, context_window_size: 1_000_000, written_at: new Date(NOW - 30_000).toISOString() });
    writeTranscript('sess', { input_tokens: 0, cache_read_input_tokens: 800_000, cache_creation_input_tokens: 0, output_tokens: 0 }, NOW - 5_000);
    const r = writeContextStatusFromTranscript({ launchDir: 'x', stateDir, transcriptDir: projDir, sessionStartMs: NOW - 60_000, now: NOW });
    expect(r).toBe('skip-fresh-statusline');
    expect(readStatus().used_percentage).toBe(40); // not overwritten
  });

  // ── token formula ────────────────────────────────────────────────────────
  it('token formula = input + cache_read + cache_creation (output_tokens EXCLUDED)', () => {
    writeStatus({ context_window_size: 1_000_000, written_at: new Date(STALE).toISOString() });
    writeTranscript('sess', { input_tokens: 10_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 40_000, output_tokens: 500_000 }, NOW - 5_000);
    const r = writeContextStatusFromTranscript({ launchDir: 'x', stateDir, transcriptDir: projDir, sessionStartMs: NOW - 60_000, now: NOW });
    expect(r).toBe('written');
    // (10k + 100k + 40k) / 1M = 15%, NOT (… + 500k) = 65%
    expect(readStatus().used_percentage).toBeCloseTo(15, 0);
  });

  // ── robustness ───────────────────────────────────────────────────────────
  it('no transcript dir → skip-no-transcript (never throws)', () => {
    writeStatus({ context_window_size: 1_000_000, written_at: new Date(STALE).toISOString() });
    const r = writeContextStatusFromTranscript({ launchDir: 'x', stateDir, transcriptDir: join(root, 'does-not-exist'), sessionStartMs: null, now: NOW });
    expect(r).toBe('skip-no-transcript');
  });

  it('malformed transcript tail (no usable usage line) → skip-no-usage', () => {
    writeStatus({ context_window_size: 1_000_000, written_at: new Date(STALE).toISOString() });
    const p = join(projDir, 'sess.jsonl');
    writeFileSync(p, '{not json\n{"type":"user","message":{}}\n');
    const secs = (NOW - 5_000) / 1000;
    utimesSync(p, secs, secs);
    const r = writeContextStatusFromTranscript({ launchDir: 'x', stateDir, transcriptDir: projDir, sessionStartMs: NOW - 60_000, now: NOW });
    expect(r).toBe('skip-no-usage');
  });
});

// ── Windows path normalization (test #5) ────────────────────────────────────
describe('claudeProjectDir — Windows colon-replace', () => {
  it('replaces the drive colon AND separators with "-" (C--Users-…, not C:-Users-…)', () => {
    const got = claudeProjectDir('C:\\Users\\steve\\cortextos\\orgs\\aunnix\\agents\\atlas');
    const expected = join(homedir(), '.claude', 'projects', 'C--Users-steve-cortextos-orgs-aunnix-agents-atlas');
    expect(got).toBe(expected);
    expect(got).not.toContain('C:-'); // the naive split(sep).join('-') bug
  });

  it('normalizes forward-slash cwd identically', () => {
    const got = claudeProjectDir('C:/Users/steve/cortextos/orgs/aunnix/agents/atlas');
    expect(got).toBe(join(homedir(), '.claude', 'projects', 'C--Users-steve-cortextos-orgs-aunnix-agents-atlas'));
  });
});
