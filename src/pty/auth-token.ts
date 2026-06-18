/**
 * Canonical OAuth-token env var name. Windows treats env keys
 * case-insensitively, but a JS env object can hold several differently-cased
 * keys at once; node-pty would then hand the child an ambiguous pair. All
 * comparisons here are done on the uppercased key so every case variant is
 * caught.
 *
 * Background — two incidents, one durable principle:
 *  - 2026-06-17: a stale CLAUDE_CODE_OAUTH_TOKEN at Windows User scope was
 *    inherited by the daemon and could shadow the valid token, 401'ing the
 *    Claude fleet for >1 day.
 *  - 2026-06-18: the OAuth token rotated overnight; agents pinned to a STATIC
 *    token (in .env, or injected from a file snapshot) 403'd on the validation
 *    path because a bare env access token has NO refresh token — `claude`
 *    cannot refresh it, so it dies on every rotation.
 *
 * DURABLE PRINCIPLE: do not INJECT a token into the child env at all. Strip
 * every inherited case variant (so nothing can shadow the credential store),
 * then inject NOTHING — `claude` reads and refreshes ~/.claude/.credentials.json
 * NATIVELY (it carries refreshToken+expiresAt and is rewritten in place), which
 * is rotation-proof. A per-agent .env token is honored ONLY as a deliberate,
 * DEPRECATED explicit override (it pins a snapshot and goes stale on rotation).
 */
export const OAUTH_TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

export type TokenSourceLabel = 'agent-env-override' | 'credentials-native';

export interface ResolvedToken {
  /** Present ONLY for a deliberate .env override; absent for the native default. */
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
 * Decide what (if anything) to inject into the child PTY env.
 *
 *   - agent .env token present → 'agent-env-override' with that token. This is a
 *     deliberate, DEPRECATED per-agent override: a static token pins a snapshot
 *     and goes stale on the next OAuth rotation. Callers should warn.
 *   - otherwise → 'credentials-native' with NO token. The child env carries no
 *     OAuth token at all and `claude` reads + refreshes
 *     ~/.claude/.credentials.json natively (rotation-proof). This is the default
 *     and the correct path.
 *
 * It NEVER reads process.env / inherited / User-scope values, and (unlike the
 * superseded design) it NEVER reads or injects a credential-store snapshot —
 * injecting a non-refreshable snapshot is exactly the 2026-06-18 recurrence bug.
 */
export function resolveCanonicalToken(agentEnvToken: string | undefined): ResolvedToken {
  if (agentEnvToken && agentEnvToken.length > 0) {
    return { token: agentEnvToken, source: 'agent-env-override' };
  }
  return { source: 'credentials-native' };
}

/**
 * Spawn-time invariant (Layer 1, loud-fail). Verifies the env we are about to
 * hand the child PTY matches the resolved decision EXACTLY — throwing (with
 * redacted tails only) rather than booting an agent onto a wrong/leaked token:
 *
 *   - 'credentials-native' (default): the child env must carry NO OAuth token of
 *     any case variant. This proves NON-injection — nothing stale/inherited
 *     leaked through, and `claude` will self-serve the credential store.
 *   - 'agent-env-override': the child env must carry EXACTLY one canonical key
 *     equal to the override token.
 */
export function assertChildAuthToken(
  env: Record<string, string | undefined>,
  resolved: ResolvedToken,
): void {
  const variantKeys = Object.keys(env).filter((k) => k.toUpperCase() === OAUTH_TOKEN_KEY);

  if (resolved.source === 'credentials-native') {
    if (variantKeys.length > 0) {
      throw new Error(
        `[auth-assert] native credential-store mode expects NO OAuth token in the child env, ` +
        `but found ${variantKeys.length} ${OAUTH_TOKEN_KEY} key(s): [${variantKeys.join(', ')}] ` +
        `tail=${redactToken(env[variantKeys[0]])} — refusing to spawn with a leaked/inherited token`,
      );
    }
    return;
  }

  // agent-env-override
  if (variantKeys.length !== 1 || variantKeys[0] !== OAUTH_TOKEN_KEY) {
    throw new Error(
      `[auth-assert] child env must carry exactly one canonical ${OAUTH_TOKEN_KEY}; ` +
      `found keys: [${variantKeys.join(', ')}]`,
    );
  }

  if (env[OAUTH_TOKEN_KEY] !== resolved.token) {
    throw new Error(
      `[auth-assert] child ${OAUTH_TOKEN_KEY} does not match the resolved ${resolved.source} token ` +
      `(child tail=${redactToken(env[OAUTH_TOKEN_KEY])}, expected tail=${redactToken(resolved.token)})`,
    );
  }
}
