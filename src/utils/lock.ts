import { writeFileSync, readFileSync, rmSync, linkSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

/**
 * Acquire a mutex lock via an ATOMIC, windowless file create.
 *
 * The lock is a regular file (`.lock`) whose content is the owner pid. It is
 * created by hard-linking a fully-written temp file into place: `linkSync` is
 * atomic and fails EEXIST if the lock already exists, and the lock file springs
 * into existence ALREADY containing the pid (it is a hardlink to the complete
 * temp). There is therefore NO instant at which `.lock` exists without its owner
 * pid — the pid-less window that permanently deadlocked the old mkdir+write
 * mutex (a crash between `mkdir` and `writeFile(pid)` left a lock nothing could
 * steal — it deafened codex's inbox for 3 days) is eliminated by construction.
 *
 * (A lighter single-op variant — `writeFileSync(lock, pid, {flag:'wx'})` — also
 * fixes the deadlock but reintroduces a microscopic open→write window where an
 * empty lock can be stolen mid-acquire; the hardlink-temp approach here is
 * windowless and was chosen for the strongest guarantee on this critical
 * primitive. Full-suite perf is identical: parallel-load flakiness is the same
 * for both and absent single-threaded — the extra temp op is not a factor.)
 *
 * Stale recovery: a holder that crashed WHILE holding the lock leaves `.lock`
 * with a dead pid; we detect that (`process.kill(pid,0)` throws) and remove it
 * so the next attempt re-links. NOTE: this recovery is not identity-safe under
 * two concurrent recoverers — the SAME pre-existing race the mkdir version had
 * (`rmSync` could nuke a peer's freshly-recovered lock). Locks are held for
 * microseconds and recovery is rare; the serialized-recovery hardening is a
 * separate fast-follow (and, when built, its recovery mutex must itself use this
 * atomic primitive — never a bare mkdir, which would re-introduce the deadlock).
 *
 * Returns true if acquired, false if another LIVE process holds it (caller retries).
 * Real filesystem failures (EACCES/ENOSPC/EROFS/ENOENT…) propagate so callers do
 * not spin against a path that will never be writable.
 */
export function acquireLock(dir: string): boolean {
  const lockFile = join(dir, '.lock');
  // randomUUID guarantees a unique temp name per attempt even across same-PID
  // worker threads / isolates (where a module-level counter would each reset);
  // 'wx' refuses to clobber any (astronomically unlikely) name collision.
  const tmpFile = join(dir, `.lock.${process.pid}.${randomUUID()}.tmp`);

  // Write the owner pid to a private temp FIRST. A real fs error here propagates.
  writeFileSync(tmpFile, String(process.pid), { flag: 'wx' });

  try {
    // Atomically publish the lock: the hardlink either creates `.lock` (already
    // holding the pid) or fails EEXIST if it is held. No pid-less window exists.
    linkSync(tmpFile, lockFile);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw err; // real filesystem failure — propagate
    }
    // Lock is held. Read the always-present owner pid; recover only if dead.
    let alive = true;
    try {
      const raw = readFileSync(lockFile, 'utf-8').trim();
      if (raw === '') {
        alive = false; // empty (legacy/partial) — recoverable
      } else {
        const pid = parseInt(raw, 10);
        if (Number.isNaN(pid)) {
          alive = false; // corrupt content — recoverable
        } else {
          try {
            process.kill(pid, 0);
          } catch {
            alive = false; // holder process is dead — recoverable
          }
        }
      }
    } catch {
      // `.lock` vanished between EEXIST and read (released concurrently) — the
      // caller's retry will re-link cleanly.
      return false;
    }
    if (alive) {
      return false; // held by a live process — caller retries
    }
    // Dead/corrupt holder: remove so the next attempt re-links. `rmSync(force)`
    // never throws on ENOENT, so a concurrent recoverer winning is harmless.
    try {
      rmSync(lockFile, { force: true });
    } catch {
      /* another recoverer won — fine */
    }
    return false; // let the caller's retry loop re-link
  } finally {
    // Drop our temp name. After a successful link the lock survives (it is a
    // separate hardlink to the same inode); on EEXIST/failure this removes the
    // orphan temp.
    try {
      unlinkSync(tmpFile);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Release a mutex lock (remove the `.lock` file).
 */
export function releaseLock(dir: string): void {
  const lockFile = join(dir, '.lock');
  try {
    rmSync(lockFile, { force: true });
  } catch {
    // Ignore errors on release
  }
}

/**
 * Inter-process lock options for `withFileLockSync`.
 */
export interface FileLockOptions {
  /** Total time to wait for the lock before throwing. Default 5000ms. */
  timeoutMs?: number;
  /** First retry delay; doubles up to maxBackoffMs. Default 5ms. */
  initialBackoffMs?: number;
  /** Cap on retry delay. Default 100ms. */
  maxBackoffMs?: number;
}

// SharedArrayBuffer + Atomics.wait gives us a clean cross-thread sleep
// from sync code without spinning the CPU.  One module-scoped buffer is
// reused across calls; we never write to it (only sleep on a wait that
// always times out at `ms`).
const SLEEP_SAB  = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_SAB);

/**
 * Acquire `dir`'s mutex, run `fn`, then release the lock — even if `fn`
 * throws.  Retries with exponential backoff (capped) until `timeoutMs`.
 *
 * Use this around any read-modify-write sequence on a per-agent file
 * (crons.json etc.) so two concurrent processes can't lose each other's
 * mutations between the read and the write (the atomic rename in
 * writeCrons is per-write only — it does NOT make the surrounding
 * read-modify-write transactional).
 *
 * @throws if the lock cannot be acquired within `timeoutMs`.
 */
export function withFileLockSync<T>(
  dir: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const timeoutMs    = opts.timeoutMs        ?? 5_000;
  const initBackoff  = opts.initialBackoffMs ?? 5;
  const maxBackoff   = opts.maxBackoffMs     ?? 100;

  // Use process.hrtime.bigint() instead of Date.now() so the timeout works
  // under vi.useFakeTimers() (which freezes Date.now).  hrtime reads the
  // monotonic clock via syscall and is not stubbed by fake-timer libraries.
  const start = process.hrtime.bigint();
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  let backoff = initBackoff;

  while (!acquireLock(dir)) {
    if (process.hrtime.bigint() - start > timeoutNs) {
      throw new Error(
        `withFileLockSync: failed to acquire lock on "${dir}" within ${timeoutMs}ms`,
      );
    }
    Atomics.wait(SLEEP_VIEW, 0, 0, backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  try {
    return fn();
  } finally {
    releaseLock(dir);
  }
}
