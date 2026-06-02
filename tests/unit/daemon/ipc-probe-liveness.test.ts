import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

class FakeSocket extends EventEmitter {
  writes: string[] = [];
  destroyed = false;

  write(data: string): void {
    this.writes.push(data);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

async function loadServerWithProbe(platformName: NodeJS.Platform, socket: FakeSocket) {
  vi.resetModules();
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return { ...actual, platform: () => platformName };
  });
  vi.doMock('crypto', async () => {
    const actual = await vi.importActual<typeof import('crypto')>('crypto');
    return { ...actual, randomInt: () => 424242 };
  });
  vi.doMock('net', async () => {
    const actual = await vi.importActual<typeof import('net')>('net');
    return { ...actual, createConnection: () => socket };
  });

  const { IPCServer } = await import('../../../src/daemon/ipc-server');
  return new IPCServer({} as any, 'probe-test');
}

describe('IPC liveness probe', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock('os');
    vi.doUnmock('crypto');
    vi.doUnmock('net');
  });

  it('returns false on win32 when a connected pipe never returns a matching pong', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const server = await loadServerWithProbe('win32', socket);

    const result = (server as any).probeSocketLive() as Promise<boolean>;
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toBe(false);
    expect(socket.writes).toHaveLength(3);
  });

  it('returns true on win32 when a slow live owner returns the nonce pong within 3s', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const server = await loadServerWithProbe('win32', socket);

    const result = (server as any).probeSocketLive() as Promise<boolean>;
    socket.emit('connect');
    setTimeout(() => {
      socket.emit('data', Buffer.from(JSON.stringify({ success: true, pong: 424242 })));
    }, 2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBe(true);
  });

  it('rejects on POSIX timeout because stale state is inconclusive', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const server = await loadServerWithProbe('linux', socket);

    const result = (server as any).probeSocketLive() as Promise<boolean>;
    const assertion = expect(result).rejects.toThrow('state unknown');
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
  });
});
