import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';

/**
 * Canonical OAuth-token env var name. Windows treats env keys
 * case-insensitively, but a JS env object can hold several differently-cased
 * keys at once; node-pty would then hand the child an ambiguous pair. All
 * comparisons here are done on the uppercased key so every case variant is
 * caught.
 *
 * Background: INCIDENT-REPORT-2026-06-17 — a stale CLAUDE_CODE_OAUTH_TOKEN at
 * Windows User scope was inherited by the daemon and shadowed the valid
 * per-agent .env token, 401'ing the whole Claude fleet for >1 day while the
 * .env looked correct. These helpers make the agent .env (then the Claude
 * credential store) the AUTHORITATIVE source and guarantee no inherited /
 * User-scope value can survive into the child PTY.
 */
export const OAUTH_TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

export type TokenSourceLabel = 'agent-env' | 'credentials-file' | 'none';

export interface ResolvedToken {
  token?: string;
  source: TokenSourceLabel;
}

/**
 * Redact a token to a last-8 tail for safe logging. NEVER returns the full
 * token. Short/garbage values are still tail-only so we can't leak a real one
 * by mis-measuring length.
 */
export function redactToken(token: string | undefined): string {
  if (!token) return '(none)';
  return '…' + token.slice(-8);
}

/**
 * Remove every case variant of CLAUDE_CODE_OAUTH_TOKEN from an env map,
 * mutating it in place. Returns the key names removed (for redacted logging).
 */
export function stripOAuthTokenVariants(env: Record<string, string | undefined>): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === OAUTH_TOKEN_KEY) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

/**
 * Read the Claude Code credential store token (~/.claude/.credentials.json →
 * claudeAiOauth.accessToken). This is the same file the `claude` CLI writes and
 * reads, so it is a valid authoritative fallback when an agent has no .env
 * token. Returns undefined on any error (missing file, malformed JSON, no
 * token) — callers decide what to do with a tokenless result.
 */
export function readCredentialsFileToken(home: string = homedir()): string | undefined {
  try {
    const f = join(home, '.claude', '.credentials.json');
    if (!existsSync(f)) return undefined;
    const j = JSON.parse(readFileSync(f, 'utf-8')) as { claudeAiOauth?: { accessToken?: string } };
    const t = j.claudeAiOauth?.accessToken;
    return typeof t === 'string' && t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the canonical OAuth token for an agent PTY.
 *
 * Precedence (authoritative-first, never inherited):
 *   1. the agent's own .env token (the source of intent)
 *   2. the Claude credential store file (~/.claude/.credentials.json)
 *
 * It deliberately NEVER consults process.env / inherited / User-scope values —
 * that inherited path is exactly the stale-token vector from the 2026-06-17
 * incident.
 */
export function resolveCanonicalToken(agentEnvToken: string | undefined, home?: string): ResolvedToken {
  if (agentEnvToken && agentEnvToken.length > 0) {
    return { token: agentEnvToken, source: 'agent-env' };
  }
  const fileToken = readCredentialsFileToken(home);
  if (fileToken) return { token: fileToken, source: 'credentials-file' };
  return { source: 'none' };
}

/**
 * Spawn-time invariant (Layer 1, loud-fail): verify the env we are about to
 * hand the child PTY carries EXACTLY the authoritative token we resolved — no
 * stale case variant leaked through, no mismatch, nothing extra. Throws (with
 * redacted tails only) rather than booting an agent onto a wrong/stale token.
 *
 * This compares the child env against the independently-resolved authoritative
 * source, not "child === .env", so it also fails closed if some later code path
 * mutates the token after canonicalization.
 */
export function assertChildAuthToken(
  env: Record<string, string | undefined>,
  resolved: ResolvedToken,
): void {
  const variantKeys = Object.keys(env).filter((k) => k.toUpperCase() === OAUTH_TOKEN_KEY);

  if (resolved.source === 'none') {
    if (variantKeys.length > 0) {
      throw new Error(
        `[auth-assert] no authoritative OAuth token resolved, but child env still carries ` +
        `${variantKeys.length} ${OAUTH_TOKEN_KEY} key(s): [${variantKeys.join(', ')}] ` +
        `tail=${redactToken(env[variantKeys[0]])} — refusing to spawn with a leaked/inherited token`,
      );
    }
    return;
  }

  if (variantKeys.length !== 1 || variantKeys[0] !== OAUTH_TOKEN_KEY) {
    throw new Error(
      `[auth-assert] child env must carry exactly one canonical ${OAUTH_TOKEN_KEY}; ` +
      `found keys: [${variantKeys.join(', ')}]`,
    );
  }

  if (env[OAUTH_TOKEN_KEY] !== resolved.token) {
    throw new Error(
      `[auth-assert] child ${OAUTH_TOKEN_KEY} does not match the authoritative ${resolved.source} token ` +
      `(child tail=${redactToken(env[OAUTH_TOKEN_KEY])}, expected tail=${redactToken(resolved.token)})`,
    );
  }
}
