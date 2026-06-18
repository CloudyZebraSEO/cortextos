import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// Virtual filesystem: org secrets.env + agent .env are the env sources that
// flow into the PTY env. Keyed by the exact paths AgentPTY builds via join().
const files: Record<string, string> = {};
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => p in files),
    readFileSync: vi.fn((p: string) => {
      if (p in files) return files[p];
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    }),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

const agentEnvPath = join(mockEnv.agentDir, '.env');
const secretsPath = join(mockEnv.projectRoot, 'orgs', mockEnv.org, 'secrets.env');

interface Captured { file: string; args: string[]; opts: any }

function spawnWith(): { pty: any; captured: Captured[] } {
  const captured: Captured[] = [];
  const pty = new AgentPTY(mockEnv, {});
  (pty as any).spawnFn = (file: string, args: string[], opts: any) => {
    captured.push({ file, args, opts });
    return { pid: 1, write() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill() {}, resize() {} };
  };
  return { pty, captured };
}

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
  vi.useFakeTimers(); // suppress the 5s/8s trust-prompt timers
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe('AgentPTY auth-token hardening (INCIDENT 2026-06-17)', () => {
  it('the agent .env token wins over a STALE inherited token in process.env (useConpty:true)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'STALE-USER-SCOPE-rwE3LQAA';
    files[agentEnvPath] = 'BOT_TOKEN=bt\nCLAUDE_CODE_OAUTH_TOKEN=VALID-FROM-ENV-FILE\n';

    const { pty, captured } = spawnWith();
    await pty.spawn('fresh', 'PROMPT');

    expect(captured).toHaveLength(1);
    const env = captured[0].opts.env;
    expect(captured[0].opts.useConpty).toBe(true);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('VALID-FROM-ENV-FILE');
    // the stale value must appear nowhere in the child env
    expect(Object.values(env)).not.toContain('STALE-USER-SCOPE-rwE3LQAA');
    // exactly one canonical token key, no case variants
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN')).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
  });

  it('strips an inherited lowercase case-variant that flows in via org secrets.env', async () => {
    // secrets.env carries a stale lowercase variant; .env carries the valid canonical.
    files[secretsPath] = 'claude_code_oauth_token=STALE-INHERITED-LOWER\nGEMINI_API_KEY=g\n';
    files[agentEnvPath] = 'CLAUDE_CODE_OAUTH_TOKEN=VALID-CANONICAL\n';

    const { pty, captured } = spawnWith();
    await pty.spawn('fresh', 'PROMPT');

    const env = captured[0].opts.env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('VALID-CANONICAL');
    expect(env.claude_code_oauth_token).toBeUndefined();
    expect(Object.values(env)).not.toContain('STALE-INHERITED-LOWER');
    expect(env.GEMINI_API_KEY).toBe('g'); // unrelated secret preserved
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN')).toHaveLength(1);
  });

  it('WARNS that a .env override is DEPRECATED, with a redacted tail and never the full token', async () => {
    files[agentEnvPath] = 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-SECRETSECRETrwE3LQAA\n';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { pty } = spawnWith();
    await pty.spawn('fresh', 'PROMPT');

    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes('DEPRECATED static .env'));
    expect(line).toBeTruthy();
    expect(line).toContain('…rwE3LQAA');
    expect(line).toContain('stale'); // explains the pin-and-go-stale risk
    expect(line).not.toContain('sk-ant-SECRETSECRET');
    warn.mockRestore();
  });

  it('injects NOTHING by default (no .env token) so Claude reads credentials.json natively', async () => {
    // no .env token → credentials-native default. Even a stale process.env value
    // must not leak into the child env.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'STALE-USER-SCOPE-rwE3LQAA';
    files[agentEnvPath] = 'BOT_TOKEN=bt\n';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { pty, captured } = spawnWith();
    await expect(pty.spawn('fresh', 'PROMPT')).resolves.toBeUndefined();

    const env = captured[0].opts.env;
    // ZERO token keys of any case variant in the child env (proves non-injection)
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN')).toHaveLength(0);
    expect(Object.values(env)).not.toContain('STALE-USER-SCOPE-rwE3LQAA');
    expect(log.mock.calls.some((c) => String(c[0]).includes('no OAuth token injected'))).toBe(true);
    log.mockRestore();
  });
});
