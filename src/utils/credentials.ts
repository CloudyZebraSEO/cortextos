import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';

/**
 * Single shared reader for the Claude Code credential store.
 *
 * Both the daemon-side authoritative OAuth chain (src/bus/oauth.ts) and the
 * agent PTY spawn path (src/pty/auth-token.ts) resolve the credential-store
 * token through THIS reader, so the two can never drift. (Background:
 * INCIDENT-REPORT-2026-06-17 — a stale CLAUDE_CODE_OAUTH_TOKEN shadowed the
 * valid token and 401'd the fleet for >1 day; the durable fix makes the
 * credential store an authoritative fallback, never process.env.)
 *
 * It lives in utils/ (not pty/ or bus/) to avoid a backwards bus->pty import.
 */
export function claudeCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

/**
 * Read ~/.claude/.credentials.json -> claudeAiOauth.accessToken.
 * Returns null on missing file / malformed JSON / absent or blank token.
 */
export function readClaudeCredentialsToken(filePath: string = claudeCredentialsPath()): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.trim() ? token : null;
  } catch {
    return null;
  }
}
