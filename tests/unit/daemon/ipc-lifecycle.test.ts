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
    await expect(
      Promise.race([
        second.start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('start() hung — EADDRINUSE retry loop?')), 3000)),
      ]),
    ).rejects.toBeTruthy();

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
});
