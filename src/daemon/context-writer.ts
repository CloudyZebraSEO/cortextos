/**
 * Daemon-side context-status writer for Claude-runtime agents (Phase-2 auto-handoff fix).
 *
 * Problem: `context_status.json` is the sole signal that drives the ~70% context
 * auto-handoff. For Claude agents its only writer is the statusLine hook, which is
 * starved during a long heads-down turn — the file goes stale, the FastChecker
 * consumer skips it, and the handoff never fires (agent runs to exhaustion).
 *
 * This module lets the daemon refresh `context_status.json` itself by reading the
 * agent's own Claude Code session transcript (`~/.claude/projects/<dir>/<session>.jsonl`),
 * which Claude appends after every API response — i.e. fresh exactly while context is
 * growing (see the LOAD-BEARING CORRECTNESS INVARIANT in the plan: a fresh `usage`
 * record is written whenever, and only when, a tool result returns to the model, so
 * staleness provably coincides with zero growth and the last-known % stays accurate).
 *
 * Design constraints (from the codex + gemini adversarial review):
 *  - Cap is NEVER inferred. The denominator (`context_window_size`) is reused from the
 *    last statusLine-written `context_status.json` (Claude knows its own cap). Unknown
 *    cap → skip, never guess (a wrong 200k-vs-1M flips 70% ↔ 14%).
 *  - Only acts on the CURRENT live session: the newest transcript must be newer than the
 *    session start, else the daemon could re-read the previous session's high transcript
 *    after a force-restart and clobber the zero-reset → restart loop. `session_id` is
 *    taken from the jsonl filename.
 *  - Writes ONLY when statusLine is undeniably stale (existing file age ≥ 2min); if
 *    statusLine is fresh it is authoritative (incl. the cap) and the daemon does nothing.
 *  - Cheap, non-blocking, error-swallowing: reads only the file tail; never throws.
 *
 * codex agents (codex-app-server runtime) have their own writer
 * (`CodexAppServerPTY.writeContextStatus`) and no Claude transcript — callers must not
 * invoke this for them.
 */

import { existsSync, readdirSync, statSync, openSync, fstatSync, readSync, closeSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteSync } from '../utils/atomic.js';

/** Only refresh when the existing statusLine value is at least this stale. */
export const CTX_STALE_GATE_MS = 2 * 60_000;
/** Backward scan: chunk size + HARD upper bound, so a pathological transcript can
 *  never make the writer read unbounded. The newest assistant usage record can sit
 *  arbitrarily far before EOF when a large tool_result line follows it — we scan
 *  backward in chunks until we find it or hit SCAN_MAX_BYTES, then give up. */
const SCAN_CHUNK_BYTES = 256 * 1024;
const SCAN_MAX_BYTES = 4 * 1024 * 1024;

export type CtxWriteResult =
  | 'written'
  | 'skip-fresh-statusline'
  | 'skip-no-cap'
  | 'skip-prev-session'
  | 'skip-no-transcript'
  | 'skip-no-usage';

/**
 * Claude Code's projects-dir name = the launch cwd with every non-alphanumeric
 * character replaced by '-'. On Windows `C:\Users\steve\…\atlas` becomes
 * `C--Users-steve-…-atlas` (the colon AND the separators are replaced) — a naive
 * `split(sep).join('-')` produces the wrong `C:-Users-…` and finds no transcript.
 */
export function claudeProjectDir(launchDir: string): string {
  return join(homedir(), '.claude', 'projects', launchDir.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Read up to the last `bytes` of a file without loading the whole thing. */
/**
 * Window occupancy from one JSONL line, or null if it is not an assistant usage record.
 * Occupancy = input + cache_read + cache_creation + output. `cache_read` already folds
 * in ALL prior turns' output (it became cached input); only the CURRENT turn's
 * `output_tokens` is not yet reflected and IS present in the window going forward, so
 * it is included (slightly conservative — biases the handoff to fire marginally early).
 */
function usageFromLine(ln: string): number | null {
  if (!ln || ln.indexOf('"usage"') === -1) return null;
  let o: any;
  try {
    o = JSON.parse(ln);
  } catch {
    return null;
  }
  const u = o && o.type === 'assistant' && o.message && o.message.usage;
  if (!u) return null;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  return input + cacheRead + cacheCreate + output;
}

interface NewestTranscript {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

/** Find the newest *.jsonl in the agent's Claude projects dir. */
function findNewestTranscript(projectDir: string): NewestTranscript | null {
  if (!existsSync(projectDir)) return null;
  let best: NewestTranscript | null = null;
  for (const f of readdirSync(projectDir)) {
    if (!f.endsWith('.jsonl')) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(projectDir, f)).mtimeMs;
    } catch {
      continue;
    }
    // Strictly-greater so iteration order never decides; on an exact mtime tie the
    // lexically-greater filename wins (deterministic). Session-identity guards below
    // are the real defense against an old file winning — this is just determinism.
    if (!best || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && f.slice(0, -'.jsonl'.length) > best.sessionId)) {
      best = { path: join(projectDir, f), sessionId: f.slice(0, -'.jsonl'.length), mtimeMs };
    }
  }
  return best;
}

/**
 * Find the newest assistant usage occupancy by scanning the transcript BACKWARD in
 * chunks. The newest usage record can sit far before EOF when a large tool_result line
 * follows it (a 64KB fixed tail would miss it and silently fail during the exact long
 * turn we are fixing). Bounded by SCAN_MAX_BYTES so a pathological file is never read
 * unbounded. Lines straddling a chunk boundary are reassembled via `carry`.
 */
function newestUsageOccupancy(transcriptPath: string): number | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    let pos = size;
    let scanned = 0;
    let carry = ''; // incomplete head of the chunk read just AFTER (later in file) this one
    while (pos > 0 && scanned < SCAN_MAX_BYTES) {
      const readLen = Math.min(SCAN_CHUNK_BYTES, pos);
      pos -= readLen;
      scanned += readLen;
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, pos);
      const text = buf.toString('utf-8') + carry;
      const lines = text.split('\n');
      // If we are not yet at the file start, this chunk's first line is incomplete
      // (its head is in an earlier chunk) — defer it to the next (earlier) iteration.
      carry = pos > 0 ? (lines.shift() ?? '') : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const occ = usageFromLine(lines[i]);
        if (occ !== null) return occ;
      }
    }
    if (pos === 0) {
      const occ = usageFromLine(carry);
      if (occ !== null) return occ;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export interface CtxWriterOpts {
  /** Agent launch cwd (working_directory || agentDir). */
  launchDir: string;
  /** `<ctxRoot>/state/<agent>` — where context_status.json lives. */
  stateDir: string;
  /** Current session start time (agent.getSessionStartTime()); null if unknown. */
  sessionStartMs: number | null;
  /** Injectable clock for tests. */
  now?: number;
  /** Test seam: override the resolved Claude projects dir (default = claudeProjectDir(launchDir)). */
  transcriptDir?: string;
  log?: (msg: string) => void;
}

/**
 * Refresh `context_status.json` from the live transcript if — and only if — statusLine
 * has gone stale, a cap is known, and the newest transcript belongs to the current
 * session. Returns a result tag (for tests / logging). Never throws.
 */
export function writeContextStatusFromTranscript(opts: CtxWriterOpts): CtxWriteResult {
  const now = opts.now ?? Date.now();
  try {
    const projectDir = opts.transcriptDir ?? claudeProjectDir(opts.launchDir);
    const newest = findNewestTranscript(projectDir);
    if (!newest) return 'skip-no-transcript';

    // Guard 1 (mtime): a transcript not newer than this session's start is the PREVIOUS
    // session (e.g. right after a force-restart, before the new jsonl exists). Acting on
    // it would clobber the zero-reset and re-fire the handoff (restart loop).
    if (opts.sessionStartMs !== null && newest.mtimeMs <= opts.sessionStartMs) {
      return 'skip-prev-session';
    }

    // Cap + staleness + session identity all come from the existing statusLine file.
    const statusPath = join(opts.stateDir, 'context_status.json');
    if (!existsSync(statusPath)) return 'skip-no-cap'; // no cap source yet → never guess
    let existing: any;
    try {
      existing = JSON.parse(readFileSync(statusPath, 'utf-8'));
    } catch {
      return 'skip-no-cap';
    }
    const writtenAt = existing && existing.written_at ? new Date(existing.written_at).getTime() : 0;

    // Guard 2 (written_at boundary): the status file itself predates this session — it is
    // the pre-restart file; wait for the fresh statusLine rather than act on stale data.
    // (mtime is race-prone if the old process flushes late; written_at is set atomically
    //  by the restart reset, so it is a race-free session boundary.)
    if (opts.sessionStartMs !== null && writtenAt < opts.sessionStartMs) {
      return 'skip-prev-session';
    }

    if (now - writtenAt < CTX_STALE_GATE_MS) {
      return 'skip-fresh-statusline'; // statusLine is fresh + authoritative (incl. cap)
    }

    // Guard 3 (positive identity): once statusLine has recorded the live session_id, the
    // transcript we picked MUST match it. Catches the racy case where an old session's
    // jsonl is newest-by-mtime but statusLine has already advanced to the new session.
    if (existing && typeof existing.session_id === 'string' && existing.session_id
        && newest.sessionId !== existing.session_id) {
      return 'skip-prev-session';
    }

    const cap = typeof existing.context_window_size === 'number' && existing.context_window_size > 0
      ? existing.context_window_size
      : null;
    if (cap === null) return 'skip-no-cap';

    const used = newestUsageOccupancy(newest.path);
    if (used === null) return 'skip-no-usage';

    const pct = Math.min(100, (used / cap) * 100);
    const payload = JSON.stringify({
      used_percentage: pct,
      context_window_size: cap,
      exceeds_200k_tokens: used > 200000,
      current_usage: null,
      session_id: newest.sessionId,
      written_at: new Date(now).toISOString(),
      source: 'daemon-transcript',
    });
    atomicWriteSync(statusPath, payload);
    opts.log?.(`ctx_status refreshed from transcript: ${Math.round(pct)}% (statusLine stale ${Math.round((now - writtenAt) / 60000)}min)`);
    return 'written';
  } catch {
    return 'skip-no-transcript'; // never throw into the poll loop
  }
}
