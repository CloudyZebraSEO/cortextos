/**
 * Pure secret redactor — pattern-based scan & substitute over a single
 * string. No I/O, no env reads, no logging side-effects. The hosting
 * module decides what to do with the result (audit-only vs live).
 *
 * Cycle 11 H1A — chokepoint redaction of inbound Telegram messages.
 * See: docs/security/redaction-hook.md
 */

export interface SecretPattern {
  /** Stable identifier (`github_pat_fine_grained`, `anthropic_api_key`, ...). */
  name: string;
  /** PCRE2-ish regex source string. Compiled with the `g` flag at runtime. */
  regex: string;
  /** Coarse classification (`vcs_token`, `llm_api_key`, ...). */
  category: string;
  /** Severity for events / audit records. */
  severity: 'info' | 'warning' | 'critical';
  /** Token used to replace matches in `live` mode. */
  replacement: string;
  /** Positive fixtures — every entry MUST redact when the pattern runs. */
  examples_match?: string[];
  /** Negative fixtures — every entry MUST NOT redact when the pattern runs. */
  examples_skip?: string[];
  /** Optional human note recorded next to the pattern in JSON. */
  ordering_note?: string;
  /** Optional FP risk note. */
  fp_risk?: string;
}

export interface SecretMatch {
  /** Pattern that matched. */
  pattern: string;
  /** Category from the pattern. */
  category: string;
  /** Severity from the pattern. */
  severity: 'info' | 'warning' | 'critical';
  /** Inclusive start offset in the ORIGINAL input. */
  start: number;
  /** Exclusive end offset in the ORIGINAL input. */
  end: number;
  /** Length of the original match. */
  length: number;
}

export interface RedactResult {
  /** Input with matches replaced by `pattern.replacement` (or original if no matches). */
  redacted: string;
  /** Ordered list of all matches found, by position. Empty when clean. */
  matches: SecretMatch[];
}

/**
 * Run patterns over `input` and return both the redacted form and the
 * list of matches.  Behavior:
 *
 *   - Patterns apply in the order supplied. First match wins per char
 *     position (later patterns cannot match inside a span already
 *     claimed by an earlier pattern). This is how we keep narrower
 *     patterns (e.g. `anthropic_api_key`) from being shadowed by
 *     broader siblings (`openai_api_key_legacy`).
 *
 *   - Offsets in returned `SecretMatch` records are against the
 *     ORIGINAL input, not the redacted output. Callers writing audit
 *     records should use these against the raw text.
 *
 *   - When `matches.length === 0`, `redacted === input` (identity).
 *
 *   - Invalid regex sources are skipped silently with no match recorded
 *     for that pattern — the redactor must never throw on bad config.
 */
export function redactSecrets(input: string, patterns: SecretPattern[]): RedactResult {
  if (!input || patterns.length === 0) {
    return { redacted: input, matches: [] };
  }

  // Collect all candidate matches across all patterns, then resolve
  // overlaps by declared-pattern-order + earlier-start-wins.
  interface Candidate {
    pattern: SecretPattern;
    patternIdx: number;
    start: number;
    end: number;
  }
  const candidates: Candidate[] = [];

  for (let i = 0; i < patterns.length; i++) {
    const pat = patterns[i]!;
    let re: RegExp;
    try {
      re = new RegExp(pat.regex, 'g');
    } catch {
      continue; // Bad regex — skip silently per contract.
    }
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      // Zero-width match guard (would loop forever).
      if (m.index === re.lastIndex) {
        re.lastIndex++;
        continue;
      }
      candidates.push({
        pattern: pat,
        patternIdx: i,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }

  if (candidates.length === 0) {
    return { redacted: input, matches: [] };
  }

  // Sort by start asc, then by pattern index asc (earlier-declared wins).
  candidates.sort((a, b) =>
    a.start !== b.start ? a.start - b.start : a.patternIdx - b.patternIdx,
  );

  // Resolve overlaps: walk in order, keep a candidate if it doesn't
  // overlap the previous accepted one. If two candidates start at the
  // same position, the earlier-declared pattern wins (already sorted).
  const accepted: Candidate[] = [];
  let cursor = -1;
  for (const c of candidates) {
    if (c.start < cursor) continue;
    accepted.push(c);
    cursor = c.end;
  }

  // Build the redacted output by splicing replacements in over the original.
  const matches: SecretMatch[] = [];
  let out = '';
  let pos = 0;
  for (const c of accepted) {
    out += input.slice(pos, c.start);
    out += c.pattern.replacement;
    pos = c.end;
    matches.push({
      pattern: c.pattern.name,
      category: c.pattern.category,
      severity: c.pattern.severity,
      start: c.start,
      end: c.end,
      length: c.end - c.start,
    });
  }
  out += input.slice(pos);

  return { redacted: out, matches };
}
