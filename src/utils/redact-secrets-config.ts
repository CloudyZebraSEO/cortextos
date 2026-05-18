/**
 * Pattern loader for the secret redactor. Resolution order:
 *
 *   1. `state/cortextos/secret-patterns.json` under the framework root
 *      (CTX_FRAMEWORK_ROOT env or process.cwd() fallback).
 *   2. Bundled defaults from `redact-secrets-defaults.ts`.
 *
 * The loader caches the parsed patterns process-wide. Hot-reload is NOT
 * supported in v1 (spec section 6, condition 2): edits to the JSON
 * require a daemon restart to take effect. Spelled out so operators
 * don't expect SIGHUP behavior.
 *
 * Mode resolution: `CORTEXTOS_REDACTION_MODE` env var, lowercase.
 * Recognized values: `disabled` (default when unset), `audit-only`, `live`.
 * Anything else falls back to `disabled` for safety.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_SECRET_PATTERNS } from './redact-secrets-defaults.js';
import type { SecretPattern } from './redact-secrets.js';

export type RedactionMode = 'disabled' | 'audit-only' | 'live';

interface CacheEntry {
  patterns: SecretPattern[];
  source: 'config-file' | 'bundled-defaults';
  loadedAt: number;
}

let cache: CacheEntry | null = null;

/**
 * Resolve the redaction mode from the environment. Off-by-default.
 * The flag is intentionally permissive — an unknown value never
 * silently turns the feature on.
 */
export function getRedactionMode(env: NodeJS.ProcessEnv = process.env): RedactionMode {
  const raw = (env.CORTEXTOS_REDACTION_MODE || '').trim().toLowerCase();
  if (raw === 'audit-only') return 'audit-only';
  if (raw === 'live') return 'live';
  return 'disabled';
}

/**
 * Locate the framework root for config-file lookup.
 * Prefer the explicit env var; otherwise fall back to cwd.
 */
function resolveFrameworkRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CTX_FRAMEWORK_ROOT || process.cwd();
}

/**
 * Load and cache the secret-pattern set. Reuses the cached value once
 * resolved; pass `forceReload` (or call `clearPatternCache()`) in tests
 * that need to swap the source between assertions.
 */
export function loadSecretPatterns(
  env: NodeJS.ProcessEnv = process.env,
  forceReload = false,
): { patterns: SecretPattern[]; source: 'config-file' | 'bundled-defaults' } {
  if (cache && !forceReload) {
    return { patterns: cache.patterns, source: cache.source };
  }

  const fwRoot = resolveFrameworkRoot(env);
  const configPath = join(fwRoot, 'state', 'cortextos', 'secret-patterns.json');

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as { patterns?: SecretPattern[] };
      if (Array.isArray(parsed?.patterns) && parsed.patterns.length > 0) {
        cache = {
          patterns: parsed.patterns,
          source: 'config-file',
          loadedAt: Date.now(),
        };
        return { patterns: cache.patterns, source: cache.source };
      }
    } catch {
      // Fall through to bundled defaults on parse error.
    }
  }

  cache = {
    patterns: DEFAULT_SECRET_PATTERNS,
    source: 'bundled-defaults',
    loadedAt: Date.now(),
  };
  return { patterns: cache.patterns, source: cache.source };
}

/**
 * Drop the cached pattern set. Used by tests.
 */
export function clearPatternCache(): void {
  cache = null;
}
