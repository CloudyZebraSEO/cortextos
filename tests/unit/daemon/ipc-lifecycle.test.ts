/**
 * tests/unit/daemon/ipc-lifecycle.test.ts
 *
 * Regression tests for the IPC-server listener/handle leak fixed as part of
 * the daemon OOM-cascade work (oracle diag-daemon-oom-2026-05-21, fix #3b):
 *   - stop() must destroy live inbound connections (not just stop accepting),
 *     otherwise lingering sockets keep the Server + its listeners referenced.
 *   - A second server bound to an already-in-use path must reject instead of
 *     spinning the EADDRINUSE retry loop forever (the old code re-called
 *     listen() from inside the error handler with no guard).
 *   - start() -> stop() -> start() must work, proving removeAllListeners()
 *     leaves the instance reusable and doesn't strand handlers.
 *
 * These spin a real net server on a unique socket/pipe path. No daemon process
 * and no AgentManager wiring is needed — the lifecycle never reaches
 * handleRequest, so a minimal cast stub suffices.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createConnection, Socket } from 'net';
import { IPCServer } from '../../../src/daemon/ipc-server';
import type { AgentManager } from '../../../src/daemon/agent-manager';
import { getIpcPath } from '../../../src/utils/paths';

// Unique instance id per server so concurrent tests never collide on a path.
function uniqueInstanceId(): string {
  return `ipclife-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const stubAgentManager = {} as AgentManager;

// Track servers/sockets created per test for guaranteed teardown.
let servers: IPCServer[] = [];
let sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets) {
    try { s.destroy(); } catch { /* ignore */ }
  }
  for (const srv of servers) {
    try { await srv.stop(); } catch { /* ignore */ }
  }
  servers = [];
  sockets = [];
});

function makeServer(instanceId: string): IPCServer {
  const srv = new IPCServer(stubAgentManager, instanceId);
  servers.push(srv);
  return srv;
}

describe('IPCServer lifecycle (OOM-cascade leak fixes)', () => {
  it('destroys a connection that floods the read buffer past the cap', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);
    await server.start();

    const client = createConnection(getIpcPath(instanceId));
    sockets.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });

    // Stream >1 MB of bytes that never form valid JSON. The server must cap
    // the per-connection buffer and destroy the socket rather than letting
    // `data` grow without bound (the slow-drip / never-valid-JSON heap vector).
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.write('x'.repeat(1024 * 1024 + 1024));
    await expect(
      Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('over-cap connection not destroyed')), 2000)),
      ]),
    ).resolves.toBeUndefined();

    await server.stop();
  });

  it('stop() destroys live inbound connections', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);
    await server.start();

    // Open a real client connection and wait until it is established.
    const client = createConnection(getIpcPath(instanceId));
    sockets.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });

    // The server must close our live socket on stop(), not leave it dangling.
    // Note: the 'close' event passes a `hadError` boolean to its listener, so
    // wrap resolve() to discard it and keep the promise resolving to undefined.
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    // stop() destroys live sockets synchronously before its first await, so
    // the client 'close' fires regardless of when the returned promise settles.
    void server.stop();
    await expect(
      Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('socket not closed by stop()')), 2000)),
      ]),
    ).resolves.toBeUndefined();
  });

  it('rejects (does not loop) when the path is already in use', async () => {
    const instanceId = uniqueInstanceId();
    const first = makeServer(instanceId);
    await first.start();

    // Second server on the same path: EADDRINUSE. The bounded retry must give
    // up and reject rather than re-listen forever. Guard with a timeout so a
    // regression (infinite loop / hang) fails the test instead of stalling it.
    const second = makeServer(instanceId);
    // Assert the SPECIFIC rejection (live-owner refusal), not just any
    // rejection — otherwise a regression that hangs would be "caught" by the
    // timeout below and falsely pass. The timeout only guards against a stall.
    await expect(
      Promise.race([
        second.start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('start() hung — EADDRINUSE retry loop?')), 3000)),
      ]),
    ).rejects.toThrow(/in use by a live process|owned by a live process/);

    // The probe-before-unlink guard must NOT have stolen the live first
    // server's path: a fresh client must still be able to connect to it.
    // (Before the guard, the EADDRINUSE handler unlinked the path blindly,
    // stranding the live server = split-brain.)
    const client = createConnection(getIpcPath(instanceId));
    sockets.push(client);
    await expect(
      new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
        setTimeout(() => reject(new Error('live server unreachable — path was stolen')), 2000);
      }),
    ).resolves.toBeUndefined();
  });

  it('stop() on a failed contender does not unlink the live owner\'s socket', async () => {
    const instanceId = uniqueInstanceId();
    const first = makeServer(instanceId);
    await first.start();

    // Contender loses the EADDRINUSE race and rejects (never owns the path).
    const second = makeServer(instanceId);
    await expect(second.start()).rejects.toBeTruthy();

    // Stopping the failed contender must be a clean no-op for the socket file:
    // it never owned the path, so it must NOT unlink the live owner's socket.
    await second.stop();

    // The live first server must still be reachable.
    const client = createConnection(getIpcPath(instanceId));
    sockets.push(client);
    await expect(
      new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
        setTimeout(() => reject(new Error('live owner unreachable — contender stop() stole the path')), 2000);
      }),
    ).resolves.toBeUndefined();
  });

  it('supports start() -> stop() -> start() (reusable after listener cleanup)', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);

    await server.start();
    // Await stop() fully: server.close() is async, so a re-start before close
    // completes could hit a transient EADDRINUSE. Awaiting proves the path is
    // genuinely free and removeAllListeners() left no stranded handlers.
    await server.stop();
    await expect(server.start()).resolves.toBeUndefined();
    await server.stop();
  });

  it('start() twice without stop() rejects (no double-bind / ownership reset)', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);
    await server.start();
    await expect(server.start()).rejects.toThrow(/already started/i);
    await server.stop();
  });

  it('concurrent stop() calls dedup to one teardown and resolve cleanly', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);
    await server.start();

    // Both calls must resolve without throwing; the second must not run a
    // premature cleanup before the first close() completes.
    const a = server.stop();
    const b = server.stop();
    await expect(Promise.all([a, b])).resolves.toBeDefined();

    // Server is fully down and reusable.
    await expect(server.start()).resolves.toBeUndefined();
    await server.stop();
  });

  it('a rejected start() does not poison the instance (retryable)', async () => {
    const instanceId = uniqueInstanceId();
    const blocker = makeServer(instanceId);
    await blocker.start();

    // Contender fails to bind (live owner). this.server must stay null so the
    // SAME instance can retry start() once the path frees — not be wedged in
    // a permanent "already started" state.
    const contender = makeServer(instanceId);
    await expect(contender.start()).rejects.toBeTruthy();

    await blocker.stop();
    await expect(contender.start()).resolves.toBeUndefined();
    await contender.stop();
  });

  it('concurrent start() calls reject the second (serialized, no shared-state race)', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);

    // Fire two starts without awaiting the first. Both run serialized on the
    // lifecycle chain: the first binds, the second then sees a live server and
    // rejects ("already started"). Exactly one wins.
    const a = server.start();
    const b = server.start();
    const results = await Promise.allSettled([a, b]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/already started/i);

    await server.stop();
  });

  it('repeated stop() during an in-flight start() each settle after real teardown', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);

    // Begin a start, then issue TWO stops before it resolves. Serialization
    // must run start -> stop -> stop in order; neither stop may resolve before
    // the actual close completes (the duplicate-stop-during-start race).
    const starting = server.start();
    const stopA = server.stop();
    const stopB = server.stop();
    await Promise.allSettled([starting, stopA, stopB]);

    // After both stops settle the server is genuinely down: the path is free
    // for an immediate re-bind. A premature stop resolution would leave the
    // close pending and this would intermittently fail with EADDRINUSE.
    const reuse = makeServer(instanceId);
    await expect(reuse.start()).resolves.toBeUndefined();
    await reuse.stop();
  });

  it('stop -> start -> stop resolves with the server actually down', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);
    await server.start();

    // Queue stop, then start, then stop — without awaiting in between. The
    // final stop must NOT short-circuit on the first stop's promise (which
    // resolves before the queued start binds); it must chain a teardown after
    // the start so the authoritative end state is DOWN.
    const s1 = server.stop();
    const st = server.start();
    const s2 = server.stop();
    await Promise.allSettled([s1, st]);
    await s2;

    // Path must be free: a brand-new server binds immediately. If the queued
    // start had been left running, this would fail with a live-owner refusal.
    const reuse = makeServer(instanceId);
    await expect(reuse.start()).resolves.toBeUndefined();
    await reuse.stop();
  });

  it('stop() during an in-flight start() does not orphan a listening server', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);

    // Begin start() but don't await it, then immediately stop(). stop() must
    // wait the start out and tear it down — leaving nothing listening.
    const starting = server.start();
    const stopping = server.stop();
    await Promise.allSettled([starting]);
    await stopping;

    // Path must be free: a brand-new server can bind it immediately.
    const reuse = makeServer(instanceId);
    await expect(reuse.start()).resolves.toBeUndefined();
    await reuse.stop();
  });

  it('start() waits for an in-flight stop() and is not stranded by it', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);
    await server.start();

    // Do NOT await stop(): start() must internally wait for the in-flight stop
    // so the old stop's teardown can't unlink the freshly-bound new socket.
    const stopping = server.stop();
    const starting = server.start();
    await expect(starting).resolves.toBeUndefined();
    await stopping;

    // The newly-started server must be live and reachable.
    const client = createConnection(getIpcPath(instanceId));
    sockets.push(client);
    await expect(
      new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
        setTimeout(() => reject(new Error('new server unreachable — in-flight stop stranded it')), 2000);
      }),
    ).resolves.toBeUndefined();
    await server.stop();
  });
});
