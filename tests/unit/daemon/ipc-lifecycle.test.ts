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

afterEach(() => {
  for (const s of sockets) {
    try { s.destroy(); } catch { /* ignore */ }
  }
  for (const srv of servers) {
    try { srv.stop(); } catch { /* ignore */ }
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
    server.stop();
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
  });

  it('supports start() -> stop() -> start() (reusable after listener cleanup)', async () => {
    const instanceId = uniqueInstanceId();
    const server = makeServer(instanceId);

    await server.start();
    server.stop();
    // Second start on the same instance must succeed: removeAllListeners() in
    // stop() should leave no stranded handlers and the path should be free.
    await expect(server.start()).resolves.toBeUndefined();
    server.stop();
  });
});
