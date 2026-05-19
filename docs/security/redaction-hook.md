# Inbound Telegram Redaction Hook

**Status:** shipped in cycle 11 (H1A + H1C), feature-flagged **off by default**.
**Origin:** C3 security incident 2026-05-17 — a pasted `github_pat` propagated to 8+ on-disk files.
**Spec:** `orgs/aunnix/agents/oracle/proposals/cycle-11-h1/redaction-spec.md`

---

## What it does

The fast-checker daemon archives every inbound Telegram message to
`~/.cortextos/{instance}/logs/{agent}/inbound-messages.jsonl`. Without
this hook, a message containing an API key sits in plaintext on disk
indefinitely. This hook runs a pattern-based scan **before** the
`appendFileSync` and (optionally) substitutes redaction tokens in place
of detected secrets, preserving the raw original under restricted
permissions for 7 days of recovery time.

Detection happens at the chokepoint: one fix point, no scattered regex
sweeps after the fact.

---

## Modes

The hook is controlled by a single environment variable:
`CORTEXTOS_REDACTION_MODE`.

| Value | Behavior |
|---|---|
| _(unset)_ / `disabled` | Default. Detector is not invoked. Identical behavior to pre-H1A. Zero risk for installs that don't opt in. |
| `audit-only` | Detector runs. On hit: raw message still archived AS-IS, a record is appended to `redaction-audit.jsonl`, and a `security/redaction_detected` event (severity `info`) is emitted. No mutation. |
| `live` | Detector runs. On hit: REDACTED message is archived, raw original is preserved under `state/{agent}/.redaction-originals/{ts}-{message_id}.json` (0600 perms), audit log written, `security/redaction_applied` event (severity `warning`) emitted. |

Any unknown value silently falls back to `disabled` — the flag is
permissive and never auto-enables.

### Recommended rollout

1. Set `CORTEXTOS_REDACTION_MODE=audit-only` in the agent's `.env` (or
   org `secrets.env`). Restart daemon.
2. Run for 7 days. Each morning, grep
   `~/.cortextos/{instance}/logs/{agent}/redaction-audit.jsonl` for
   `"action":"would-redact"` entries.
3. If the audit log is clean (no unexplained false positives), flip the
   env var to `live`. Restart daemon.
4. Operate. Recover any over-redacted messages from
   `.redaction-originals/` (see Recovery below).

---

## Patterns

Patterns load from `state/cortextos/secret-patterns.json` at daemon
start. If the file is missing, the bundled defaults in
`src/utils/redact-secrets-defaults.ts` are used — the two are kept in
lock-step by `tests/unit/redact-secrets.test.ts`.

### Adding a pattern

1. Edit `state/cortextos/secret-patterns.json`. Each entry needs:
   - `name` — stable identifier
   - `regex` — PCRE2-ish source (the runtime compiles with `g` flag)
   - `category` — coarse classification (`vcs_token`, `llm_api_key`, ...)
   - `severity` — `info` | `warning` | `critical`
   - `replacement` — token substituted in `live` mode
   - `examples_match[]` — positive fixtures (drive the unit tests)
   - `examples_skip[]` — negative fixtures
2. Restart the daemon. **There is no SIGHUP / live reload in v1.**
   Deferred to cycle 13+. Spelled out so operators don't expect it.
3. Re-run `npm test`. New fixtures auto-generate new test cases.

### Ordering matters

Patterns apply in **declared order**, first-match-wins per character
position. This is why `anthropic_api_key` (`sk-ant-...`) is declared
**before** `openai_api_key_legacy` (`sk-...`) — a string like
`sk-ant-api03-…` must claim the narrower pattern first so the broader
sibling can't shadow it.

The shipped `openai_api_key_legacy` regex (`sk-[A-Za-z0-9]{32,}`) won't
actually match `sk-ant-...` (the hyphen at position 5 breaks the char
class) — the ordering is documentation + future-proofing. The test
suite asserts the negative explicitly.

### Shipped patterns (v1)

12 patterns covering GitHub PATs (fine-grained, classic, app-secret),
LLM keys (Anthropic, OpenAI legacy/project, Gemini), AWS access keys,
Stripe live/test secrets, Slack bot tokens, and Telegram bot tokens.

Deferred to cycle 12: generic JWT (high FP risk) and high-entropy
base64 (catches tool payloads).

See `state/cortextos/secret-patterns.json` for the full list, including
`fp_risk` notes per pattern.

---

## Audit log format

Path: `~/.cortextos/{instance}/logs/{agent}/redaction-audit.jsonl`

One JSON object per line:

```json
{
  "ts": "2026-05-18T05:30:00Z",
  "message_id": 311,
  "from": 1536425742,
  "matches": [
    {
      "pattern": "github_pat_fine_grained",
      "category": "vcs_token",
      "severity": "critical",
      "start": 12,
      "end": 108,
      "length": 96
    }
  ],
  "mode": "audit-only",
  "action": "would-redact"
}
```

- `action: "would-redact"` in `audit-only` mode (no mutation).
- `action: "redacted"` in `live` mode.

Offsets are against the ORIGINAL message body, not the redacted form.

---

## Recovery flow (live mode)

If a legitimate token is over-redacted, the raw message is preserved.

1. Locate the original:
   ```sh
   ls ~/.cortextos/{instance}/state/{agent}/.redaction-originals/
   # Files named: {ISO-ts}-{message_id}.json
   ```
2. Read the file (it's a JSON envelope with the original message
   under the `original` key).
3. Restore the value into wherever it's needed — manually, by hand,
   one-time.

**Retention:** 7-day rolling. Files older than 7 days are unlinked by
the daemon cleanup loop on its next tick after they expire. The
permissions on both the directory (0700) and individual files (0600)
keep them readable only by the daemon's user.

If you need to keep an original beyond 7 days, copy it out of
`.redaction-originals/` into your own storage before the GC sweep.

---

## Events

Both events use the new `security` category (cycle 11 H1C).

| Mode | Event | Severity | Emitted when |
|---|---|---|---|
| `audit-only` | `security/redaction_detected` | `info` | One or more matches found, no mutation. |
| `live` | `security/redaction_applied` | `warning` | One or more matches found, archive was redacted. |

Clean messages (zero matches) emit **no event** regardless of mode —
this keeps the activity feed signal-to-noise high. If you need to
audit total inbound traffic, use the existing
`message/telegram_received` event.

Event metadata:

```json
{
  "message_id": 311,
  "from": 1536425742,
  "match_count": 1,
  "patterns": ["github_pat_fine_grained"],
  "mode": "live"
}
```

---

## What this hook does NOT do

- **Not a generic DLP scanner.** Catches known-format tokens; arbitrary
  PII (names, addresses, etc.) is out of scope.
- **Not a replacement for `.env` hygiene or git pre-commit scanning.**
  Different layer, different threat model.
- **Not retroactive.** Existing leaks need a manual sweep — already
  done as part of C3.
- **Does not redact outbound messages.** Agents may legitimately send
  credential-shaped strings as part of their work output (e.g.
  describing a redaction). Deferred to cycle 13+.
- **Does not redact agent stdout logs.** PM2 owns those; different
  chokepoint, separate proposal.
- **No encryption at rest** on `.redaction-originals/` in v1.
  Permission-restricted plaintext (0600) matches the existing `.env`
  trust model. Encryption-at-rest deferred to cycle 13+ pending a
  cross-platform secret-store design.

---

## Code paths

- `src/utils/redact-secrets.ts` — pure detector + replacer.
- `src/utils/redact-secrets-config.ts` — env-mode + config-file loader.
- `src/utils/redact-secrets-defaults.ts` — bundled fallback patterns.
- `src/telegram/logging.ts` — `logInboundMessage` wrap.
- `state/cortextos/secret-patterns.json` — authored patterns.
- `tests/unit/redact-secrets.test.ts` — fixture-driven coverage.
- `tests/unit/redact-secrets-integration.test.ts` — mode-by-mode
  filesystem integration.
