import { describe, it, expect, afterEach } from 'vitest';
import { IPCClient, IPCServer } from '../../../src/daemon/ipc-server';

const servers: IPCServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
});

describe('IPC ping', () => {
  it('echoes the probe nonce so Windows liveness checks can verify the owner', async () => {
    const instanceId = `ping-test-${Date.now()}`;
    const server = new IPCServer({} as any, instanceId);
    servers.push(server);
    await server.start();

    const client = new IPCClient(instanceId);
    const response = await client.send({ type: 'ping', nonce: 123456 });

    expect(response).toEqual({ success: true, pong: 123456 });
  });
});
