import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, withFileLockSync } from '../../../src/utils/lock';

// A pid that is (essentially) guaranteed not to be a live process, so the
// liveness check (process.kill(pid, 0)) throws and the holder reads as dead.
const DEAD_PID = 2147483647;

describe('atomic file-based locking (.lock, windowless acquire)', () => {
  let testDir: string;
  const lockFile = () => join(testDir, '.lock');

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('acquires on an empty dir; .lock exists holding our pid; no orphan temp', () => {
    expect(acquireLock(testDir)).toBe(true);
    expect(existsSync(lockFile())).toBe(true);
    // windowless invariant: the lock file ALWAYS carries the owner pid.
    expect(readFileSync(lockFile(), 'utf-8').trim()).toBe(String(process.pid));
    // the temp used to link the lock is cleaned up (no .lock.<pid>.<seq>.tmp left).
    expect(readdirSync(testDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    releaseLock(testDir);
  });

  it('prevents double acquire while a LIVE holder owns it (our own live pid)', () => {
    expect(acquireLock(testDir)).toBe(true);
    expect(acquireLock(testDir)).toBe(false); // our pid is alive → not stolen
    releaseLock(testDir);
  });

  it('releases and reacquires', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
    expect(existsSync(lockFile())).toBe(false);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('recovers a DEAD-pid lock (crash-while-holding): first call clears, retry acquires', () => {
    writeFileSync(lockFile(), String(DEAD_PID)); // simulate a holder that crashed
    expect(acquireLock(testDir)).toBe(false);    // detects dead → removes (caller retries)
    expect(existsSync(lockFile())).toBe(false);  // stale lock cleared
    expect(acquireLock(testDir)).toBe(true);     // retry re-links cleanly
    expect(readFileSync(lockFile(), 'utf-8').trim()).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('recovers a CORRUPT lock (non-numeric content)', () => {
    writeFileSync(lockFile(), 'not-a-pid');
    expect(acquireLock(testDir)).toBe(false);    // corrupt → recoverable, removed
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('recovers an EMPTY lock (pid-less leftover — the bug class, now self-healing)', () => {
    writeFileSync(lockFile(), '');               // a pid-less lock would have deadlocked the old mutex
    expect(acquireLock(testDir)).toBe(false);    // empty → recoverable, removed
    expect(existsSync(lockFile())).toBe(false);
    expect(acquireLock(testDir)).toBe(true);     // NOT a permanent deadlock anymore
    releaseLock(testDir);
  });

  describe('withFileLockSync', () => {
    it('runs fn under the lock and releases after', () => {
      let ran = false;
      withFileLockSync(testDir, () => { ran = true; });
      expect(ran).toBe(true);
      expect(existsSync(lockFile())).toBe(false); // released
      expect(acquireLock(testDir)).toBe(true);    // free again
      releaseLock(testDir);
    });

    it('releases the lock even if fn throws', () => {
      expect(() => withFileLockSync(testDir, () => { throw new Error('boom'); })).toThrow('boom');
      expect(existsSync(lockFile())).toBe(false); // released on throw
      expect(acquireLock(testDir)).toBe(true);
      releaseLock(testDir);
    });

    it('serializes: a live foreign holder blocks until released, then succeeds', () => {
      // Simulate a live foreign holder by linking a lock that names OUR (alive) pid.
      writeFileSync(lockFile(), String(process.pid));
      // withFileLockSync should time out fast against a live holder.
      expect(() => withFileLockSync(testDir, () => { /* unreachable */ }, { timeoutMs: 60 }))
        .toThrow(/failed to acquire/);
      // After release, it acquires + runs.
      releaseLock(testDir);
      let ran = false;
      withFileLockSync(testDir, () => { ran = true; });
      expect(ran).toBe(true);
    });
  });
});
