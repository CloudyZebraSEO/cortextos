import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// Virtual filesystem for credential-store reads. Keyed by the exact path
// `readCredentialsFileToken` builds (join(home, '.claude', '.credentials.json')).
const files: Record<string, string> = {};
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => p in files),
    readFileSync: vi.fn((p: string) => {
      if (p in files) return files[p];
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    }),
  };
});

const {
  OAUTH_TOKEN_KEY,
  redactToken,
  stripOAuthTokenVariants,
  resolveCanonicalToken,
  assertChildAuthToken,
} = await import('../../../src/pty/auth-token.js');
// The single shared credential-store reader (utils/credentials.ts) — exercised
// here from the PTY side; bus/oauth.ts exercises the same reader on its side.
const { readClaudeCredentialsToken } = await import('../../../src/utils/credentials.js');

const HOME = '/home/tester';
const credPath = join(HOME, '.claude', '.credentials.json');

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
});
afterEach(() => vi.clearAllMocks());

describe('redactToken', () => {
  it('returns (none) for empty/undefined', () => {
    expect(redactToken(undefined)).toBe('(none)');
    expect(redactToken('')).toBe('(none)');
  });
  it('returns only the last-8 tail, never the full token', () => {
    const tok = 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAArwE3LQAA';
    const red = redactToken(tok);
    expect(red).toBe('…rwE3LQAA');
    expect(red).not.toContain('sk-ant');
    expect(red.length).toBeLessThan(tok.length);
  });
});

describe('stripOAuthTokenVariants', () => {
  it('removes every case variant in place and reports the removed keys', () => {
    const env: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'stale-upper',
      claude_code_oauth_token: 'stale-lower',
      Claude_Code_Oauth_Token: 'stale-mixed',
      OTHER: 'keep',
    };
    const removed = stripOAuthTokenVariants(env);
    expect(removed.sort()).toEqual(
      ['CLAUDE_CODE_OAUTH_TOKEN', 'Claude_Code_Oauth_Token', 'claude_code_oauth_token'].sort(),
    );
    expect(Object.keys(env).filter((k) => k.toUpperCase() === OAUTH_TOKEN_KEY)).toHaveLength(0);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.OTHER).toBe('keep');
  });
  it('is a no-op (empty result) when no token variant is present', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
    expect(stripOAuthTokenVariants(env)).toEqual([]);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('readClaudeCredentialsToken (shared reader)', () => {
  it('reads claudeAiOauth.accessToken from ~/.claude/.credentials.json', () => {
    files[credPath] = JSON.stringify({ claudeAiOauth: { accessToken: 'valid-from-file' } });
    expect(readClaudeCredentialsToken(credPath)).toBe('valid-from-file');
  });
  it('returns null when the file is missing', () => {
    expect(readClaudeCredentialsToken(credPath)).toBeNull();
  });
  it('returns null on malformed JSON', () => {
    files[credPath] = '{ not json';
    expect(readClaudeCredentialsToken(credPath)).toBeNull();
  });
  it('returns null when accessToken is absent/empty/blank', () => {
    files[credPath] = JSON.stringify({ claudeAiOauth: {} });
    expect(readClaudeCredentialsToken(credPath)).toBeNull();
    files[credPath] = JSON.stringify({ claudeAiOauth: { accessToken: '' } });
    expect(readClaudeCredentialsToken(credPath)).toBeNull();
    files[credPath] = JSON.stringify({ claudeAiOauth: { accessToken: '   ' } });
    expect(readClaudeCredentialsToken(credPath)).toBeNull();
  });
});

describe('resolveCanonicalToken — inject nothing by default, never inherited', () => {
  it('returns agent-env-override (with the token) ONLY when .env carries a token', () => {
    expect(resolveCanonicalToken('env-tok')).toEqual({ token: 'env-tok', source: 'agent-env-override' });
  });
  it('returns credentials-native with NO token when .env has no token', () => {
    expect(resolveCanonicalToken(undefined)).toEqual({ source: 'credentials-native' });
    expect(resolveCanonicalToken('')).toEqual({ source: 'credentials-native' });
  });
  it('NEVER reads process.env, and NEVER reads/injects a credential-store snapshot', () => {
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'STALE-USER-SCOPE';
    files[credPath] = JSON.stringify({ claudeAiOauth: { accessToken: 'valid-file-token' } });
    try {
      // Even with a valid credential file present, the default injects NOTHING —
      // claude must read+refresh credentials.json natively (the inject-nothing fix).
      const r = resolveCanonicalToken(undefined);
      expect(r).toEqual({ source: 'credentials-native' });
      expect(r.token).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    }
  });
});

describe('assertChildAuthToken — spawn-time invariant (inverted: proves non-injection)', () => {
  it('credentials-native PASSES when the child env carries NO token at all (proves non-injection)', () => {
    expect(() => assertChildAuthToken({ PATH: '/x' }, { source: 'credentials-native' })).not.toThrow();
  });
  it('credentials-native THROWS when any token leaked into the child env', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'leaked-inherited' };
    expect(() => assertChildAuthToken(env, { source: 'credentials-native' })).toThrow(/refusing to spawn/);
  });
  it('credentials-native THROWS on a leaked lowercase case variant too', () => {
    const env: Record<string, string | undefined> = { claude_code_oauth_token: 'leaked-lower' };
    expect(() => assertChildAuthToken(env, { source: 'credentials-native' })).toThrow(/refusing to spawn/);
  });
  it('agent-env-override PASSES when child env carries exactly the override token', () => {
    const env = { PATH: '/x', CLAUDE_CODE_OAUTH_TOKEN: 'good' };
    expect(() => assertChildAuthToken(env, { token: 'good', source: 'agent-env-override' })).not.toThrow();
  });
  it('agent-env-override THROWS when the child token does NOT match the override', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'STALE' };
    expect(() => assertChildAuthToken(env, { token: 'good', source: 'agent-env-override' })).toThrow(/does not match/);
  });
  it('agent-env-override THROWS when a stale case variant survives alongside the canonical key', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: 'good',
      claude_code_oauth_token: 'STALE',
    };
    expect(() => assertChildAuthToken(env, { token: 'good', source: 'agent-env-override' })).toThrow(/exactly one canonical/);
  });
  it('never includes the raw token in the thrown message', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'STALE-SECRET-VALUE-12345678' };
    try {
      assertChildAuthToken(env, { token: 'good-secret-87654321', source: 'agent-env-override' });
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('STALE-SECRET-VALUE-12345678');
      expect(msg).not.toContain('good-secret-87654321');
      expect(msg).toContain('…'); // redacted tail marker
    }
  });
});
