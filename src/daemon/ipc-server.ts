import { createServer, createConnection, Server, Socket } from 'net';
import { existsSync, unlinkSync, chmodSync, readFileSync } from 'fs';
import { join, resolve as pathResolve } from 'path';
import type { IPCRequest, IPCResponse, CronSummaryRow, CronDefinition } from '../types/index.js';
import { AgentManager } from './agent-manager.js';
import { getIpcPath } from '../utils/paths.js';
import { readCrons, getExecutionLog, getExecutionLogPage, addCron, updateCron, removeCron, getCronByName } from '../bus/crons.js';
import type { ExecutionLogStatusFilter } from '../bus/crons.js';
import { nextFireFromCron } from './cron-scheduler.js';
import { parseDurationMs } from '../bus/cron-state.js';
import { computeHealth, aggregateFleetHealth } from '../utils/cron-health.js';

const WORKER_NAME_REGEX = /^[a-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Manual fire cooldown — Subtask 4.5
// ---------------------------------------------------------------------------

/** Cooldown window (ms) between manual test-fire requests for the same cron. */
export const MANUAL_FIRE_COOLDOWN_MS = 30_000;

/**
 * In-memory map tracking the last manual fire time per (agent, cronName).
 * Key format: `${agent}::${cronName}`.
 * Exported for testing; do not mutate directly outside tests.
 */
export const _manualFireLastFired = new Map<string, number>();

/**
 * Returns the remaining cooldown in milliseconds for a given (agent, cronName).
 * Returns 0 when the cooldown has elapsed (or was never set).
 *
 * @param agent    - Agent name.
 * @param cronName - Cron name.
 * @param nowMs    - Current epoch ms (injectable for testing).
 */
export function manualFireCooldownRemaining(
  agent: string,
  cronName: string,
  nowMs = Date.now(),
): number {
  const key = `${agent}::${cronName}`;
  const lastFired = _manualFireLastFired.get(key);
  if (lastFired === undefined) return 0;
  const elapsed = nowMs - lastFired;
  return elapsed >= MANUAL_FIRE_COOLDOWN_MS ? 0 : MANUAL_FIRE_COOLDOWN_MS - elapsed;
}

/**
 * Result returned by handleFireCron.
 */
export interface FireCronResult {
  ok: boolean;
  firedAt?: number;
  error?: string;
}

/**
 * fire-cron handler — validates manualFireDisabled + cooldown, then injects
 * the cron's prompt into the agent's PTY.
 *
 * @param agent      - Agent name.
 * @param cronName   - Cron name.
 * @param injectFn   - Injection function (agentManager.injectAgent or test stub).
 * @param nowMs      - Epoch ms for "now" (injectable for testing).
 */
export function handleFireCron(
  agent: string | undefined,
  cronName: string | undefined,
  injectFn: (agent: string, text: string) => boolean,
  nowMs = Date.now(),
): FireCronResult {
  if (!agent || !agent.trim()) {
    return { ok: false, error: 'Agent name is required.' };
  }
  if (!cronName || !cronName.trim()) {
    return { ok: false, error: 'Cron name is required.' };
  }

  // Look up the cron definition
  const cron = getCronByName(agent, cronName);
  if (!cron) {
    return { ok: false, error: `Cron '${cronName}' not found for agent '${agent}'.` };
  }

  // Enforce manualFireDisabled opt-out
  if (cron.manualFireDisabled) {
    return { ok: false, error: 'Manual fire disabled for this cron.' };
  }

  // Enforce cooldown
  const remaining = manualFireCooldownRemaining(agent, cronName, nowMs);
  if (remaining > 0) {
    const waitSec = Math.ceil(remaining / 1000);
    return { ok: false, error: `Cooldown active — wait ${waitSec}s before firing again.` };
  }

  // Inject into PTY
  const injection = `[CRON: ${cronName}] ${cron.prompt}`;
  const injected = injectFn(agent, injection);
  if (!injected) {
    return { ok: false, error: `Agent '${agent}' not found or not running.` };
  }

  // Record fire time for cooldown tracking
  const firedAt = nowMs;
  _manualFireLastFired.set(`${agent}::${cronName}`, firedAt);

  return { ok: true, firedAt };
}

// ---------------------------------------------------------------------------
// list-all-crons helper — Subtask 4.1
// ---------------------------------------------------------------------------

/**
 * Compute the next fire timestamp (ISO string) for a cron definition.
 * Reuses the same parser logic as CronScheduler (nextFireFromCron + parseDurationMs)
 * without duplicating the parser.
 *
 * @param schedule    - Interval shorthand or 5-field cron expression.
 * @param lastFiredAt - ISO 8601 of last fire; if absent uses `now`.
 * @param now         - Epoch ms for "now" (injectable for testing).
 */
export function computeNextFire(
  schedule: string,
  lastFiredAt: string | undefined,
  now = Date.now(),
): string {
  const referenceMs = lastFiredAt ? new Date(lastFiredAt).getTime() : now;

  const durationMs = parseDurationMs(schedule);
  if (!isNaN(durationMs)) {
    const next = referenceMs + durationMs;
    // If next is still in the past (daemon was stopped for a long time), advance to now
    return new Date(next <= now ? now + durationMs : next).toISOString();
  }

  // Try as a 5-field cron expression
  const nextMs = nextFireFromCron(schedule, now);
  if (!isNaN(nextMs)) {
    return new Date(nextMs).toISOString();
  }

  // Unparseable schedule — return a sentinel so callers can detect it
  return 'unknown';
}

/**
 * Walk all enabled agents from enabled-agents.json, read each agent's crons.json
 * and cron execution log, and return a combined summary array.
 */
function listAllCrons(): CronSummaryRow[] {
  const ctxRoot = process.env.CTX_ROOT ?? process.cwd();
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');

  let enabledAgents: Record<string, { enabled?: boolean; org?: string }> = {};
  if (existsSync(enabledFile)) {
    try {
      enabledAgents = JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      // corrupt — fall through with empty map
    }
  }

  const rows: CronSummaryRow[] = [];
  const now = Date.now();

  for (const [agentName, entry] of Object.entries(enabledAgents)) {
    if (entry.enabled === false) continue;

    const org = entry.org ?? '';
    const crons = readCrons(agentName);

    for (const cron of crons) {
      // Read the last execution log entry for this cron
      const logEntries = getExecutionLog(agentName, cron.name, 1);
      const lastEntry = logEntries.length > 0 ? logEntries[logEntries.length - 1] : null;

      rows.push({
        agent: agentName,
        org,
        cron,
        lastFire: lastEntry?.ts ?? null,
        lastStatus: lastEntry?.status ?? null,
        nextFire: computeNextFire(cron.schedule, cron.last_fired_at, now),
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// fleet-health handler — Subtask 4.4
// ---------------------------------------------------------------------------

interface FleetHealthCacheEntry {
  result: ReturnType<typeof aggregateFleetHealth>;
  expiresAt: number;
}

/** 30-second in-process cache to avoid hammering disk on rapid dashboard polls. */
let _fleetHealthCache: FleetHealthCacheEntry | null = null;
const FLEET_HEALTH_CACHE_TTL_MS = 30_000;

/**
 * Compute fleet health across all enabled agents.
 * Walks crons.json + last-24h execution log for each agent and cron.
 * Result is cached for 30 seconds.
 *
 * @param agentFilter - Optional agent name to restrict results to.
 * @param nowMs       - Epoch ms for "now" (injectable for testing).
 */
export function computeFleetHealth(
  agentFilter?: string,
  nowMs = Date.now(),
): ReturnType<typeof aggregateFleetHealth> {
  // Check cache (skip when agentFilter is set — filtered views don't cache)
  if (!agentFilter && _fleetHealthCache && nowMs < _fleetHealthCache.expiresAt) {
    return _fleetHealthCache.result;
  }

  const ctxRoot = process.env.CTX_ROOT ?? process.cwd();
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');

  let enabledAgents: Record<string, { enabled?: boolean; org?: string }> = {};
  if (existsSync(enabledFile)) {
    try {
      enabledAgents = JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      // corrupt — continue with empty
    }
  }

  const cutoff24h = nowMs - 24 * 60 * 60 * 1000;
  const rows = listAllCrons();

  // Build per-cron execution lists for the last 24h in one pass per agent
  // to avoid reading the log file once per cron.
  const execMap = new Map<string, typeof rows[0]['cron'] extends infer _ ? ReturnType<typeof getExecutionLog> : never>();

  // Pre-read execution logs per agent
  const agentsWithCrons = new Set(rows.map(r => r.agent));
  for (const agentName of agentsWithCrons) {
    const allEntries = getExecutionLog(agentName, undefined, 0); // all entries
    for (const entry of allEntries) {
      if (new Date(entry.ts).getTime() < cutoff24h) continue;
      const key = `${agentName}::${entry.cron}`;
      if (!execMap.has(key)) execMap.set(key, []);
      execMap.get(key)!.push(entry);
    }
  }

  const healthRows = rows
    .filter(r => !agentFilter || r.agent === agentFilter)
    .map(r => {
      const key = `${r.agent}::${r.cron.name}`;
      const last24h = execMap.get(key) ?? [];
      return computeHealth(r, last24h, nowMs);
    });

  const result = aggregateFleetHealth(healthRows);

  // Cache only unfiltered results
  if (!agentFilter) {
    _fleetHealthCache = { result, expiresAt: nowMs + FLEET_HEALTH_CACHE_TTL_MS };
  }

  return result;
}

/** Invalidate the fleet-health cache (call after mutations). */
export function invalidateFleetHealthCache(): void {
  _fleetHealthCache = null;
}

// ---------------------------------------------------------------------------
// Cron mutation helpers — Subtask 4.2
// ---------------------------------------------------------------------------

/** Interval shorthand regex — matches "6h", "30m", "1d", "2w" etc. */
const INTERVAL_REGEX = /^\d+(s|m|h|d|w)$/;

/** Cron name must be non-empty and contain only URL-safe chars (no whitespace). */
const CRON_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a schedule string as either an interval shorthand or a valid
 * 5-field cron expression.  Returns true if valid.
 */
export function isValidSchedule(schedule: string): boolean {
  if (!schedule || !schedule.trim()) return false;
  const s = schedule.trim();
  if (INTERVAL_REGEX.test(s)) return true;
  // Try 5-field cron expression via nextFireFromCron — if it returns NaN it's invalid.
  const parts = s.split(/\s+/);
  if (parts.length !== 5) return false;
  const testMs = nextFireFromCron(s, Date.now());
  return !isNaN(testMs);
}

/**
 * Read the list of enabled agent names from enabled-agents.json.
 */
function getEnabledAgents(): string[] {
  const ctxRoot = process.env.CTX_ROOT ?? process.cwd();
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  if (!existsSync(enabledFile)) return [];
  try {
    const data = JSON.parse(readFileSync(enabledFile, 'utf-8')) as Record<
      string,
      { enabled?: boolean }
    >;
    return Object.entries(data)
      .filter(([, v]) => v.enabled !== false)
      .map(([k]) => k);
  } catch {
    return [];
  }
}

/**
 * Structured result returned by IPC mutation handlers.
 * ok: true means success; ok: false means a validation / not-found error.
 */
export interface MutationResult {
  ok: boolean;
  error?: string;
  field?: string;
}

/**
 * add-cron handler — validates inputs and delegates to bus/crons addCron.
 */
export function handleAddCron(
  agent: string | undefined,
  definition: Partial<CronDefinition> | undefined,
): MutationResult {
  // Validate agent
  if (!agent || !agent.trim()) {
    return { ok: false, error: 'Agent name is required.', field: 'agent' };
  }
  const enabledAgents = getEnabledAgents();
  if (enabledAgents.length > 0 && !enabledAgents.includes(agent)) {
    return {
      ok: false,
      error: `Agent '${agent}' not found. Enabled agents: ${enabledAgents.join(', ')}`,
      field: 'agent',
    };
  }

  // Validate definition shape
  if (!definition || typeof definition !== 'object') {
    return { ok: false, error: 'definition is required.', field: 'definition' };
  }

  // Validate name
  const name = definition.name ?? '';
  if (!name || !CRON_NAME_REGEX.test(name)) {
    return {
      ok: false,
      error: 'Cron name must be non-empty with no whitespace (letters, digits, _ and - only).',
      field: 'name',
    };
  }

  // Validate schedule
  const schedule = definition.schedule ?? '';
  if (!isValidSchedule(schedule)) {
    return {
      ok: false,
      error: `Invalid schedule '${schedule}'. Use an interval (e.g. "6h", "30m") or a 5-field cron expression (e.g. "0 9 * * *").`,
      field: 'schedule',
    };
  }

  // Validate prompt
  const prompt = definition.prompt ?? '';
  if (!prompt || !prompt.trim()) {
    return { ok: false, error: 'Prompt is required and must be non-empty.', field: 'prompt' };
  }

  const fullDef: CronDefinition = {
    name,
    prompt: prompt.trim(),
    schedule: schedule.trim(),
    enabled: definition.enabled !== false,
    created_at: new Date().toISOString(),
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.metadata ? { metadata: definition.metadata } : {}),
    ...(definition.manualFireDisabled !== undefined
      ? { manualFireDisabled: !!definition.manualFireDisabled }
      : {}),
  };

  try {
    addCron(agent, fullDef);
  } catch (err) {
    // addCron throws on duplicate name
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, field: 'name' };
  }

  return { ok: true };
}

/**
 * update-cron handler — validates and patches an existing cron.
 */
export function handleUpdateCron(
  agent: string | undefined,
  name: string | undefined,
  patch: Partial<CronDefinition> | undefined,
): MutationResult {
  if (!agent || !agent.trim()) {
    return { ok: false, error: 'Agent name is required.', field: 'agent' };
  }
  if (!name || !name.trim()) {
    return { ok: false, error: 'Cron name is required.', field: 'name' };
  }
  if (!patch || typeof patch !== 'object') {
    return { ok: false, error: 'patch is required.', field: 'patch' };
  }

  // Validate schedule if provided
  if (patch.schedule !== undefined) {
    if (!isValidSchedule(patch.schedule)) {
      return {
        ok: false,
        error: `Invalid schedule '${patch.schedule}'. Use an interval (e.g. "6h") or a 5-field cron expression.`,
        field: 'schedule',
      };
    }
  }

  // Validate prompt if provided
  if (patch.prompt !== undefined && !patch.prompt.trim()) {
    return { ok: false, error: 'Prompt must be non-empty.', field: 'prompt' };
  }

  const found = updateCron(agent, name, patch);
  if (!found) {
    return { ok: false, error: `Cron '${name}' not found for agent '${agent}'.` };
  }

  return { ok: true };
}

/**
 * remove-cron handler — removes a cron by agent + name.
 */
export function handleRemoveCron(
  agent: string | undefined,
  name: string | undefined,
): MutationResult {
  if (!agent || !agent.trim()) {
    return { ok: false, error: 'Agent name is required.', field: 'agent' };
  }
  if (!name || !name.trim()) {
    return { ok: false, error: 'Cron name is required.', field: 'name' };
  }

  const found = removeCron(agent, name);
  if (!found) {
    return { ok: false, error: `Cron '${name}' not found for agent '${agent}'.` };
  }

  return { ok: true };
}

/**
 * IPC server for CLI <-> daemon communication.
 * Uses Unix domain socket on macOS/Linux, named pipe on Windows.
 * Replaces SIGUSR1 and other signal-based IPC.
 */
/**
 * Idle timeout (ms) for an inbound IPC connection. A well-behaved client
 * connects, sends one JSON request, gets a response, and the socket closes.
 * A client that connects but never sends a complete JSON message would
 * otherwise keep its socket (and its growing `data` buffer) alive forever.
 * Over a 71h daemon lifetime these abandoned half-open sockets accumulate
 * into the handle/heap leak oracle observed (diag-daemon-oom-2026-05-21).
 * 30s is far longer than any real request needs.
 */
const IPC_CONN_IDLE_MS = 30_000;

export class IPCServer {
  private server: Server | null = null;
  private socketPath: string;
  private agentManager: AgentManager;
  /**
   * Live inbound connections. Tracked so stop() can destroy every open
   * socket — otherwise lingering sockets keep the server (and its listeners)
   * referenced after close, leaking across daemon restart attempts.
   */
  private connections = new Set<Socket>();
  /** Guards the EADDRINUSE recovery so it retries listen() at most once. */
  private eaddrinuseRetried = false;
  /**
   * True only once THIS instance has successfully bound the socket path.
   * stop() captures this synchronously and unlinks the socket file only when
   * set — otherwise a contender instance that lost the EADDRINUSE race (and
   * never owned the path) could unlink the LIVE owner's socket on its own
   * stop(), stranding the real daemon. Reset on every start().
   */
  private ownsSocketPath = false;
  /** In-flight stop() promise; dedups concurrent/repeated stop() calls. */
  private stopPromise: Promise<void> | null = null;
  /** In-flight start() promise; rejects concurrent starts and lets stop() wait one out. */
  private startPromise: Promise<void> | null = null;

  constructor(agentManager: AgentManager, instanceId: string = 'default') {
    this.agentManager = agentManager;
    this.socketPath = getIpcPath(instanceId);
  }

  /**
   * Start listening for IPC connections.
   *
   * Serializes against itself and against stop(): a start already in progress
   * makes a second start() reject (rather than racing two binds that share
   * eaddrinuseRetried/ownsSocketPath), and stop() can observe startPromise to
   * wait an in-flight start out before tearing down.
   */
  async start(): Promise<void> {
    if (this.startPromise) {
      throw new Error('IPCServer.start() called while a start is already in progress');
    }
    this.startPromise = this._doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async _doStart(): Promise<void> {
    // If a stop() is still in flight, wait for it to fully complete before
    // (re)starting. Otherwise this start() could bind a new server while the
    // previous stop's deferred teardown is still pending — and that teardown,
    // reading instance state, could then unlink the freshly-bound socket.
    if (this.stopPromise) await this.stopPromise;

    // Refuse to start twice on the same instance — a second start() would
    // reset ownership state and leak the first server. Lifecycle must be
    // start -> stop -> start, never start -> start.
    if (this.server) {
      throw new Error('IPCServer.start() called while already started');
    }

    this.eaddrinuseRetried = false;
    this.ownsSocketPath = false;

    // A leftover socket file does NOT prove the previous daemon is dead.
    // Probe for a live owner before touching it: if something answers, refuse
    // to start (another daemon owns the path — split-brain guard). Only when
    // the probe confirms nothing is listening do we treat it as a stale
    // leftover from a crashed predecessor and unlink it. (Windows named pipes
    // are not filesystem entries, so existsSync is always false there and the
    // EADDRINUSE handler below is the equivalent guard.)
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      const live = await this.probeSocketLive();
      if (live) {
        throw new Error(
          `IPC path ${this.socketPath} is owned by a live process; refusing to start a second daemon.`,
        );
      }
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }

    return new Promise<void>((resolve, reject) => {
      // Build the server in a LOCAL — this.server is committed only once
      // listen() succeeds. A start() that rejects (live-owner conflict,
      // EACCES, probe failure, …) must NOT leave this.server set, or the
      // instance would be permanently poisoned ("already started") and the
      // caller would have to know to stop() a server that never listened.
      const server = createServer((socket: Socket) => {
        // Track the connection so stop() can tear it down, and untrack it
        // whenever it closes (normal end, error, or idle-timeout destroy).
        this.connections.add(socket);
        socket.once('close', () => this.connections.delete(socket));

        // Destroy abandoned/half-open connections that never deliver a
        // complete request — otherwise their socket + data buffer leak.
        socket.setTimeout(IPC_CONN_IDLE_MS, () => socket.destroy());

        let data = '';
        socket.on('data', (chunk) => {
          data += chunk.toString();
          // Try to parse complete JSON messages
          try {
            const request: IPCRequest = JSON.parse(data);
            data = '';
            this.handleRequest(request, socket);
          } catch {
            // Incomplete JSON, wait for more data
          }
        });

        socket.on('error', () => {
          // Client disconnected — 'close' fires next and untracks the socket.
        });
      });

      // Tear down a server that failed to come up and reject, leaving the
      // instance reusable (this.server stays null, so start() can be retried).
      const failStart = (err: Error): void => {
        try { server.removeAllListeners(); } catch { /* ignore */ }
        try { server.close(); } catch { /* ignore */ }
        reject(err);
      };

      const onListening = (recovered: boolean): void => {
        if (process.platform !== 'win32') {
          try {
            chmodSync(this.socketPath, 0o600);
          } catch {
            /* Windows / no-op */
          }
        }
        // Commit ownership only now that THIS server holds the path.
        this.server = server;
        this.ownsSocketPath = true;
        console.log(`[ipc] Listening on ${this.socketPath}${recovered ? ' (recovered from stale socket)' : ''}`);
        resolve();
      };

      // EADDRINUSE recovery. The previous implementation re-called listen()
      // from inside this handler with no guard: if the socket stayed in use
      // (e.g. an orphan daemon still holding the pipe — exactly the dup-poller
      // scenario in diag-daemon-oom-2026-05-21), each failed retry re-emitted
      // 'error', which called listen() again, spinning a tight infinite retry
      // loop that leaked listeners/handles and burned heap. Now we retry the
      // stale-socket cleanup at most once, then reject so the daemon surfaces
      // the real failure instead of looping.
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && !this.eaddrinuseRetried) {
          this.eaddrinuseRetried = true;
          // Narrow race: a socket appeared between the start-top probe/unlink
          // and listen() (e.g. a predecessor bound it, or a process was killed
          // mid-bind). Re-probe before unlinking — blindly removing it could
          // strand a live owner = split-brain. Only unlink + retry listen once
          // when nothing is listening; otherwise reject and surface the truth.
          this.probeSocketLive().then((live) => {
            if (live) {
              failStart(new Error(
                `IPC path ${this.socketPath} is in use by a live process; refusing to unlink it ` +
                `(another daemon may already be running).`,
              ));
              return;
            }
            try { unlinkSync(this.socketPath); } catch { /* ignore */ }
            server.listen(this.socketPath, () => onListening(true));
          }).catch(failStart);
        } else {
          failStart(err);
        }
      });

      server.listen(this.socketPath, () => onListening(false));
    });
  }

  /**
   * Probe whether a process is currently listening on socketPath.
   *
   * Resolves `true` when a live listener accepts the connection, `false` when
   * the path is provably stale (nothing listening — ECONNREFUSED/ENOENT).
   * Rejects on an inconclusive error (EACCES/EPERM/etc.) or timeout, where
   * unlinking would be unsafe: callers must NOT remove a path they cannot
   * prove is dead. A single `settled` guard ensures exactly one outcome and
   * detaches the probe's own listeners so a late event can't re-trigger the
   * stale-socket branch after the promise already settled.
   */
  private probeSocketLive(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(this.socketPath);
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probe.removeAllListeners();
        probe.destroy();
        fn();
      };
      const timer = setTimeout(
        () => done(() => reject(new Error(
          `IPC path ${this.socketPath} liveness probe timed out (state unknown).`,
        ))),
        1_000,
      );
      timer.unref();
      probe.once('connect', () => done(() => resolve(true)));
      probe.once('error', (err: NodeJS.ErrnoException) => {
        // ECONNREFUSED / ENOENT mean nothing is listening → stale path.
        // Any other error (EACCES, EPERM, …) is inconclusive: reject so the
        // caller refuses to unlink rather than risk stranding a live owner.
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          done(() => resolve(false));
        } else {
          done(() => reject(err));
        }
      });
    });
  }

  /**
   * Stop the IPC server. Resolves once the underlying server has fully closed.
   *
   * Dedups concurrent stop() calls via stopPromise, and waits out an in-flight
   * start() (if any) before tearing down so a late onListening() can't orphan
   * a listening server. The resource-releasing teardown itself lives in
   * _doStop() and runs synchronously up front (see its doc) so the synchronous
   * process.on('exit') fire-and-forget path still releases everything.
   */
  stop(): Promise<void> {
    // A stop already in flight: return the same promise so a second stop()
    // never double-runs teardown before the first close() callback has fired.
    if (this.stopPromise) return this.stopPromise;

    if (this.startPromise) {
      // A start is still in flight. Wait it out before tearing down — its
      // deferred onListening() could otherwise commit this.server AFTER we
      // stopped, leaving an orphaned listening server. (Unreachable on the
      // synchronous process.on('exit') path: the daemon's boot start()
      // resolved long before shutdown, so there is no in-flight start there
      // and the synchronous teardown in _doStop() still applies.)
      this.stopPromise = this.startPromise
        .catch(() => { /* start failed — it committed nothing to tear down */ })
        .then(() => this._doStop());
    } else {
      this.stopPromise = this._doStop();
    }
    // Clear the handle once teardown settles so a later start->stop cycle is
    // not wedged on a stale promise.
    void this.stopPromise.finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  /**
   * Actual teardown. The steps that matter for resource release — destroying
   * live sockets, capturing ownership, nulling this.server, calling
   * server.close(), and unlinking the socket file when we own it — all run
   * SYNCHRONOUSLY before the first await point, so a fire-and-forget call from
   * the synchronous process.on('exit') handler still releases everything;
   * only the close-completion wait (and the cosmetic removeAllListeners) is
   * skipped there. Ownership is captured into a LOCAL so the unlink decision
   * can never be flipped by a concurrent start() mutating instance state.
   */
  private _doStop(): Promise<void> {
    // Destroy any still-open connections first. server.close() only stops
    // accepting new connections — it does NOT close live sockets, and a
    // lingering socket keeps the server (and its listeners) referenced,
    // which is part of the leak across restart attempts.
    for (const socket of this.connections) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.connections.clear();

    const server = this.server;
    const owned = this.ownsSocketPath;
    this.server = null;
    this.ownsSocketPath = false;

    // Unlink the socket file synchronously when THIS stop owned it. Safe now
    // (all connections destroyed; close initiated below) and — crucially —
    // this is the only teardown step that can run when stop() is called
    // fire-and-forget from the synchronous process.on('exit') handler, where
    // async close callbacks never fire. Using the captured `owned` (not the
    // live flag) means a concurrent start() can't make us unlink its socket.
    if (owned) this.unlinkSocketFile();

    if (!server) {
      // Never started (or already fully stopped) — nothing async to wait on.
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        // Strip listeners only AFTER close completes so the Server object can
        // be GC'd cleanly and a re-created server in a later start() never
        // inherits stale handlers (the source of the "MaxListenersExceeded
        // Warning: 11 listeners" the daemon logged before this fix).
        server.removeAllListeners();
        resolve();
      };
      // close() stops accepting new connections and fires once all connections
      // are closed — we destroyed them above, so this is prompt.
      server.close(() => finish());
      // Safety net: never hang a caller if close() somehow never calls back.
      setTimeout(finish, 2000).unref();
    });
  }

  /**
   * Remove the Unix socket file (no-op on Windows named pipes).
   *
   * Unconditional: the ownership decision is made by the caller (stop()
   * captures `owned` synchronously and only calls this when true). Keeping
   * the gate out of here avoids reading mutable instance state that a
   * concurrent start() could have changed.
   */
  private unlinkSocketFile(): void {
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Handle an incoming IPC request.
   */
  private handleRequest(request: IPCRequest, socket: Socket): void {
    // BUG-015: log every incoming IPC request with its source so we can
    // trace which CLI command triggered which daemon action. The source
    // field is populated by CLI clients (cortextos enable / disable / stop
    // / bus / etc.); older or untracked callers fall back to 'unknown'.
    const agentTag = request.agent ? ` ${request.agent}` : '';
    console.log(`[ipc] ${request.type}${agentTag} from ${request.source || 'unknown'}`);

    let response: IPCResponse;

    try {
      switch (request.type) {
        case 'status':
          response = {
            success: true,
            data: this.agentManager.getAllStatuses(),
          };
          break;

        case 'list-agents':
          response = {
            success: true,
            data: this.agentManager.getAgentNames(),
          };
          break;

        case 'start-agent':
          if (!request.agent) {
            response = { success: false, error: 'Agent name required', code: 'INVALID_INPUT' };
          } else {
            // Inspect synchronously so the IPC response distinguishes DEDUPED
            // from NOT_FOUND (issue #346). The async dispatch is unchanged —
            // agent-manager's own dedup logic still runs and is the source of
            // truth; we just give the operator a structured response code.
            const insp = this.agentManager.inspectAgentOp('start', request.agent);
            this.agentManager.startAgent(
              request.agent,
              (request.data?.dir as string) || '',
            ).catch(err => console.error(`Failed to start ${request.agent}:`, err));
            if (insp.ok) {
              response = { success: true, data: `Starting ${request.agent}` };
            } else {
              console.log(`[ipc] start-agent ${request.agent}: ${insp.code} — ${insp.message}`);
              response = { success: false, error: insp.message, code: insp.code };
            }
          }
          break;

        case 'stop-agent':
          if (!request.agent) {
            response = { success: false, error: 'Agent name required', code: 'INVALID_INPUT' };
          } else {
            const insp = this.agentManager.inspectAgentOp('stop', request.agent);
            this.agentManager.stopAgent(request.agent)
              .catch(err => console.error(`Failed to stop ${request.agent}:`, err));
            if (insp.ok) {
              response = { success: true, data: `Stopping ${request.agent}` };
            } else {
              console.log(`[ipc] stop-agent ${request.agent}: ${insp.code} — ${insp.message}`);
              response = { success: false, error: insp.message, code: insp.code };
            }
          }
          break;

        case 'restart-agent':
          if (!request.agent) {
            response = { success: false, error: 'Agent name required', code: 'INVALID_INPUT' };
          } else {
            const insp = this.agentManager.inspectAgentOp('restart', request.agent);
            this.agentManager.restartAgent(request.agent)
              .catch(err => console.error(`Failed to restart ${request.agent}:`, err));
            if (insp.ok) {
              response = { success: true, data: `Restarting ${request.agent}` };
            } else {
              console.log(`[ipc] restart-agent ${request.agent}: ${insp.code} — ${insp.message}`);
              response = { success: false, error: insp.message, code: insp.code };
            }
          }
          break;

        case 'wake':
          // Wake a specific agent's fast checker (replaces SIGUSR1)
          if (request.agent) {
            const checker = this.agentManager.getFastChecker(request.agent);
            if (checker) {
              checker.wake();
              response = { success: true, data: 'Woke fast checker' };
            } else {
              response = { success: false, error: `Agent ${request.agent} not found` };
            }
          } else {
            response = { success: false, error: 'Agent name required' };
          }
          break;

        case 'spawn-worker': {
          const d = request.data as { name?: string; dir?: string; prompt?: string; parent?: string; model?: string } | undefined;
          if (!d?.name || !d?.dir || !d?.prompt) {
            response = { success: false, error: 'spawn-worker requires: name, dir, prompt' };
          } else if (!WORKER_NAME_REGEX.test(d.name) || d.name.length > 64) {
            response = { success: false, error: 'Invalid worker name' };
          } else {
            const resolvedDir = pathResolve(d.dir);
            const ctxRoot = process.env.CTX_ROOT ? pathResolve(process.env.CTX_ROOT) : '';
            const cwd = pathResolve(process.cwd());
            const underCtxRoot = ctxRoot && (resolvedDir === ctxRoot || resolvedDir.startsWith(ctxRoot + '/'));
            const underCwd = resolvedDir === cwd || resolvedDir.startsWith(cwd + '/');
            if (!underCtxRoot && !underCwd) {
              response = { success: false, error: 'Invalid worker dir' };
            } else {
              this.agentManager.spawnWorker(d.name, resolvedDir, d.prompt, d.parent, d.model)
                .catch(err => console.error(`[ipc] spawn-worker failed:`, err));
              response = { success: true, data: `Spawning worker ${d.name}` };
            }
          }
          break;
        }

        case 'terminate-worker': {
          const workerName = request.data?.name as string | undefined;
          if (!workerName) {
            response = { success: false, error: 'terminate-worker requires: name' };
          } else {
            this.agentManager.terminateWorker(workerName)
              .catch(err => console.error(`[ipc] terminate-worker failed:`, err));
            response = { success: true, data: `Terminating worker ${workerName}` };
          }
          break;
        }

        case 'list-workers':
          response = { success: true, data: this.agentManager.listWorkers() };
          break;

        case 'inject-worker': {
          const injectName = request.data?.name as string | undefined;
          const injectText = request.data?.text as string | undefined;
          if (!injectName || !injectText) {
            response = { success: false, error: 'inject-worker requires: name, text' };
          } else {
            const ok = this.agentManager.injectWorker(injectName, injectText);
            response = ok
              ? { success: true, data: `Injected into worker ${injectName}` }
              : { success: false, error: `Worker ${injectName} not found or not running` };
          }
          break;
        }

        case 'inject-agent': {
          const agentToInject = request.agent;
          const textToInject = request.data?.text as string | undefined;
          if (!agentToInject || !textToInject) {
            response = { success: false, error: 'inject-agent requires: agent, data.text', code: 'INVALID_INPUT' };
          } else {
            // Structured outcome distinguishes NOT_FOUND (agent not in registry)
            // from NOT_RUNNING (registered but PTY dead) from DEDUPED (content
            // collision in MessageDedup window). Closes the conflation Boris
            // surfaced — the harness "3 not found errors" were dedup hits.
            // See issue #346.
            const result = this.agentManager.injectAgentDetailed(agentToInject, textToInject);
            if (result.ok) {
              response = { success: true, data: `Injected into agent ${agentToInject}` };
            } else {
              console.log(`[ipc] inject-agent ${agentToInject}: ${result.code} — ${result.message}`);
              response = { success: false, error: result.message, code: result.code };
            }
          }
          break;
        }

        case 'reload-crons': {
          const agentToReload = request.agent;
          if (!agentToReload) {
            response = { success: false, error: 'reload-crons requires agent name' };
          } else {
            // crons.json was already written atomically by the CLI — acknowledge the reload.
            // CronScheduler picks up the change on its next 30s tick.
            this.agentManager.reloadCrons(agentToReload);
            response = { success: true, data: `Crons reloaded for ${agentToReload}` };
          }
          break;
        }

        case 'fire-cron': {
          const agentToFire = request.agent;
          const fireCronName = request.data?.name as string | undefined;
          const fireCronResult = handleFireCron(
            agentToFire,
            fireCronName,
            (a, text) => this.agentManager.injectAgent(a, text),
          );
          if (fireCronResult.ok) {
            // Invalidate fleet health cache so next poll reflects the new fire
            invalidateFleetHealthCache();
            response = {
              success: true,
              data: { ok: true, firedAt: fireCronResult.firedAt },
            };
          } else {
            response = { success: false, error: fireCronResult.error };
          }
          break;
        }

        case 'list-all-crons': {
          response = {
            success: true,
            data: listAllCrons(),
          };
          break;
        }

        case 'fleet-health': {
          const agentFilter = request.agent ?? (request.data?.agent as string | undefined);
          response = {
            success: true,
            data: computeFleetHealth(agentFilter),
          };
          break;
        }

        case 'list-cron-executions': {
          const execAgent = request.agent;
          const execCronName = request.data?.cronName as string | undefined;
          const execLimit = typeof request.data?.limit === 'number' ? request.data.limit : 100;
          const execOffset = typeof request.data?.offset === 'number' ? request.data.offset : 0;
          const rawStatusFilter = request.data?.statusFilter as string | undefined;
          const execStatusFilter: ExecutionLogStatusFilter =
            rawStatusFilter === 'success' || rawStatusFilter === 'failure'
              ? rawStatusFilter
              : 'all';
          if (!execAgent) {
            response = { success: false, error: 'list-cron-executions requires agent name' };
          } else {
            const page = getExecutionLogPage(execAgent, execCronName, execLimit, execOffset, execStatusFilter);
            response = { success: true, data: page };
          }
          break;
        }

        case 'add-cron': {
          const result = handleAddCron(
            request.agent,
            request.data?.definition as Partial<CronDefinition> | undefined,
          );
          if (result.ok) {
            // Trigger scheduler reload for this agent
            if (request.agent) this.agentManager.reloadCrons(request.agent);
            response = { success: true, data: { ok: true } };
          } else {
            response = { success: false, error: result.error ?? 'add-cron failed', data: result };
          }
          break;
        }

        case 'update-cron': {
          const result = handleUpdateCron(
            request.agent,
            request.data?.name as string | undefined,
            request.data?.patch as Partial<CronDefinition> | undefined,
          );
          if (result.ok) {
            if (request.agent) this.agentManager.reloadCrons(request.agent);
            response = { success: true, data: { ok: true } };
          } else {
            response = { success: false, error: result.error ?? 'update-cron failed', data: result };
          }
          break;
        }

        case 'remove-cron': {
          const result = handleRemoveCron(
            request.agent,
            request.data?.name as string | undefined,
          );
          if (result.ok) {
            if (request.agent) this.agentManager.reloadCrons(request.agent);
            response = { success: true, data: { ok: true } };
          } else {
            response = { success: false, error: result.error ?? 'remove-cron failed', data: result };
          }
          break;
        }

        default:
          response = { success: false, error: `Unknown command: ${request.type}` };
      }
    } catch (err) {
      response = { success: false, error: String(err) };
    }

    try {
      socket.write(JSON.stringify(response));
      socket.end();
    } catch {
      // Client disconnected
    }
  }
}

/**
 * IPC client for sending commands to the daemon.
 * Used by CLI commands.
 */
export class IPCClient {
  private socketPath: string;

  constructor(instanceId: string = 'default') {
    this.socketPath = getIpcPath(instanceId);
  }

  /**
   * Send a command to the daemon and get the response.
   */
  async send(request: IPCRequest): Promise<IPCResponse> {
    const { createConnection } = require('net');

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        socket.write(JSON.stringify(request));
      });

      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid response from daemon'));
        }
      });

      socket.on('error', (err: Error) => {
        if ((err as any).code === 'ECONNREFUSED' || (err as any).code === 'ENOENT') {
          resolve({
            success: false,
            error: 'Daemon is not running. Start it with: cortextos start',
          });
        } else {
          reject(err);
        }
      });

      // Timeout after 5 seconds
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('IPC request timed out'));
      });
    });
  }

  /**
   * Check if the daemon is running.
   */
  async isDaemonRunning(): Promise<boolean> {
    try {
      const response = await this.send({ type: 'status' });
      return response.success;
    } catch {
      return false;
    }
  }
}
