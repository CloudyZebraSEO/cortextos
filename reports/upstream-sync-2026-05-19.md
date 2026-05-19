# Upstream Sync Report — 2026-05-19

**Author:** codex (aunnix specialist)
**Sync window:** previous sync 2026-05-13 → this one 2026-05-19 (6 days)
**Upstream:** grandamenium/cortextos
**Integration branch:** `sync/upstream-2026-05-19` (off `main`)
**Merge commit:** `62bddb4`

---

## TL;DR

- **14 new upstream commits** merged. 3 features, 11 fixes. 62 files, +3064/−1136.
- **3 hard conflicts** at merge time, all in `templates/{agent,analyst,orchestrator}/.claude/settings.json` (upstream `3ab8c11` collided with our extended `permissions.allow` list). Resolved as **union** (kept our list, added their `defaultMode: "bypassPermissions"`).
- **Build:** `npm run build` green (410ms).
- **Test delta (Windows, under live-agent shell):**
  - Pre-merge baseline: **44 failed** (categorized in `workspace/triage-2026-05-13.md`)
  - Immediately post-merge: **70 failed** (env canary `fe39493` exposed 26 latent test-isolation issues — the right shape, not a regression)
  - After 12 cross-platform fix commits: **11 failed** (all in deferred buckets: fakeTimer race, perf budgets, simulation timing)
- **No Mac/Linux regressions expected:** 11 of 12 commits are platform-neutral. The one platform-branched commit (`7bb1a8e` ENOSPC test skip on Windows) is gated behind `process.platform === 'win32'`.
- **Codex CLI adversarial review** during Phase 1 caught 6 factual errors and 3 UNVERIFIED claims in my v1 merge plan. Self-review discipline reaffirmed.

---

## §2 — New Features (grouped by impact)

### Major / Strategic

| Commit | Title | What it does | **Utilization** |
|---|---|---|---|
| `23f5895` | Obsidian wiki viewer (#412) | New `/wiki` dashboard surface with PARA-tree browsing, search, and inbox routes; reads org's Obsidian vault via `CTX_VAULT_PATH` or `~/<home>/Obsidian/...` fallback. | **UNUSED in aunnix today.** Aunnix has no Obsidian vault wired in. Could become valuable if/when org-level knowledge migrates to Obsidian. Recommend exploring after first venture lands. |
| `8719612` | Quota indicator + watchdog scripts (#411) | Topbar quota indicator (session + weekly tokens) reading Claude OAuth state. Companion bash scripts (`bin/quota-*.sh`) for auto-pause-on-quota. | **PARTIAL.** Dashboard component will show on Windows. Bash watchdog scripts (`bin/quota-watchdog.sh` etc.) won't run on Windows without WSL or git-bash daemonization. Discuss whether `usage` agent should own a Node port of the watchdog. |

### Tooling

| Commit | Title | What it does | **Utilization** |
|---|---|---|---|
| `0f6bdfc` | `react-telegram` for single-emoji acks (#406) | New `cortextos bus react-telegram <chat-id> <message-id> [emoji]` command + TelegramAPI.setMessageReaction wrapper. | **HIGH.** Every agent inherits awareness via SYSTEM.md template — already discoverable post-merge. Should adopt to reduce reply noise (default 👍 for read-receipt-style acks instead of a verbal reply). Worth a 1-line addition to SOUL.md communication section. |
| `0867fa7` | `cortextos update` apply path (#421) | New `cortextos update [-y] [--check]` CLI command wrapping `checkUpstream()` with confirmation. | **MEDIUM.** Useful for future syncs — operator runs `cortextos update --check` daily and `cortextos update -y` to apply when greenlit. **No unit tests upstream**; one to add post-merge or in our test suite. |

### Ops / Daemon

| Commit | Title | What it does | **Utilization** |
|---|---|---|---|
| `caa4ef9` | CrashLoopPauser + `AgentConfig.crash_window` (#377) | Sliding-window crash detector (e.g. 3 crashes in 30 min → halt). Optional config: `crash_window: { seconds, max_crashes }`. | **MEDIUM.** Worth enabling on all aunnix agents to catch crash loops earlier. Recommend setting `crash_window: { seconds: 1800, max_crashes: 3 }` in template defaults. |

### Docs

(none added in this batch.)

---

## §3 — Fixes (table with Action column)

| Commit | Fix | Action |
|---|---|---|
| `d7b37f0` | Dashboard: use `systemName` for heartbeat lookup + detail link | **None.** Bug only manifests when an agent's display name differs from its system name — not affecting aunnix today. |
| `3553a88` | Telegram: stop HTML-escaping in plain-text mode (e.g. `'5 > 4'` no longer shows as `'5 &gt; 4'`) | **None.** Picked up automatically. Already gives cleaner Telegram messages where plain-text mode is used. |
| `3ab8c11` | Templates: `permissions.defaultMode = "bypassPermissions"` | **None — conflict resolved at merge.** Same fix applied to our extended allow-list via union merge. Sibling action: agent-codex template still has no `.claude/settings.json` (likely intentional — codex runtime is CLI, not Claude Code harness). Verify post-Steve-approval. |
| `e282d9f` | Hooks: bus fan-out reachable when Telegram creds absent | **None.** Was unreachable for hermes-runtime and pre-onboarding agents. Now visible on bus. |
| `02d9702` | Daemon: codex-app-server back-online Telegram fires from daemon | **None.** Already mirrors crash-recovery direct-send pattern. |
| `8a82502` | Daemon: thread `--model` through spawn-worker to AgentPTY | **None.** Fixes silent model-fallback bug. |
| `f3b0278` | Daemon: clear error message on invalid config.json | **None.** Better operator UX on JSON syntax errors. |
| `2d0f7c1` | IPC: distinguishes `DEDUPED` / `NOT_FOUND` / `NOT_RUNNING` on start/stop/restart/inject-agent | **Adopt in operator scripts.** Operators (and agents) should program against `IPCResponse.code` now, not string-matching error messages. Update any pm2/restart wrapper scripts. |
| `caa4ef9` (type half) | Types: `AgentConfig.crash_window` declared | **None.** Required by the CrashLoopPauser fix above. |
| `fe39493` | Env: `CTX_AGENT_DIR` must be subordinate to `CTX_FRAMEWORK_ROOT`; `CTX_PROJECT_ROOT` must equal `CTX_FRAMEWORK_ROOT` when both set | **Surfaced 26 test-isolation issues** (Cat E in our triage). Fixed downstream as part of our Phase 2 work — see `vitest.config.ts` + `tests/setup-env.ts` + `tests/unit/cli/enable-agent-validation.test.ts` USERPROFILE override. **Known Windows gap in the canary itself:** case-sensitive `startsWith()` may produce false positives on UNC/case-variant paths. Worth a follow-up PR. |

---

## §4 — New known issues (introduced or surfaced by this merge)

1. **fakeTimer + real-Date race in `fast-checker.ts:waitForBootstrap`.** Tests using `vi.useFakeTimers()` (default) don't fake `Date`, so the watchdog's `Date.now() - start < timeoutMs` loop guard uses real time while `await sleep(2000)` uses fake time. The bootstrap-gate test sees the watchdog fire prematurely. **Not introduced by this merge — was already failing pre-merge.** Fix needs vitest `{ toFake: ['Date'] }` plus likely a small refactor of waitForBootstrap to not use Date in fake-timer-friendly paths.

2. **Perf budgets set for Linux p95** in `phase4-performance.test.ts` (3 tests, GET `/api/workflows/crons`) and `phase5-performance.test.ts` (3–4 tests, 1000-cron scaling). Windows process-spawn cost is higher; budgets fail under real Windows scheduling jitter. **Org policy decision required:** relax the budget, or skipIf(win32) with a Windows-specific budget.

3. **Phase 2 backtesting + phase5-e2e-simulation simulation tests** (3) — share root cause with #1 (fakeTimer race). Same fix path.

4. **`fe39493` env canary lacks case-folded/UNC path handling on Windows.** Upstream tests pass (POSIX strings), but in real Windows shells a casing variant could trip the canary. Worth an upstream PR.

5. **`0867fa7` (`cortextos update`) has no unit tests upstream** — a destructive apply path wrapped in `CORTEXTOS_CONFIRM_UPSTREAM_MERGE='yes'`. We should add tests before depending on it.

6. **Bash quota-watchdog scripts (`bin/quota-*.sh`) won't run on Windows.** If aunnix wants quota auto-pause on Windows, port to Node or skip; do not rely on the bash flow.

---

## §5 — Strategic opportunities

- **Adopt `react-telegram` across the fleet.** Single-line addition to SOUL.md communication section: "for low-content acks, prefer `cortextos bus react-telegram` over a verbal reply." Reduces Telegram noise for every agent, surfacing more signal to Steve.
- **Enable CrashLoopPauser on all aunnix agents** by adding `crash_window: { seconds: 1800, max_crashes: 3 }` to the org-level template defaults. Catches loops 30+ min earlier than the daily counter.
- **Wire Obsidian vault** if/when aunnix wants the `/wiki` dashboard surface. Requires `CTX_VAULT_PATH` env or a vault path in `orgs/aunnix/knowledge.md`. Decision can wait until first venture lands.
- **Open Phase 5 push-back PRs to grandamenium** in this sequence (clean, test-only first for goodwill):
  1. CRLF tolerance in YAML frontmatter regex (`332ca07`)
  2. Path-separator-agnostic assertions (`d298a50`, `8bf3ed4`, `a64bfc8`, `e3dc4ce`)
  3. Vitest scrub of inherited `CTX_AGENT_DIR` (`9e73aa4`) — useful for any contributor running tests inside an active cortextOS shell
  4. `enable-agent` test USERPROFILE override on Windows (`29b2ae8`)
  5. `catalog` `path.sep` fix (`0a6e9d2`) — only product-code fix; bigger review burden but real bug
  6. **Optional later:** ENOSPC POSIX-only skip (`7bb1a8e`) — could pair with a Windows ACL-based test to keep coverage symmetric
- **Set up an experiment cycle** on Windows-test-greenness as a `coding_capability` adjacent metric? Probably overkill; the 7d coding_capability cycle is enough self-eval.

---

## Appendix — Phase 2 commits (all on `sync/upstream-2026-05-19`)

```
92fb346 test(add-agent-codex): bump expected skill count to 24 (mirrors three-brain)
7bb1a8e test(phase5-failure-modes): skip POSIX-only ENOSPC scenario on Windows  [WIN-GATED]
e3dc4ce test(agent-process): normalize fs mock path for .daemon-stop existsSync (Windows)
a64bfc8 test(knowledge-base): normalize fs mock path before suffix check (Windows)
29b2ae8 test(enable-agent): also override USERPROFILE so homedir() works on Windows
8bf3ed4 test(sprint4-catalog): normalize target path to forward-slash before .toContain
0a6e9d2 fix(catalog): use path.sep in install-path subordinate-check on Windows
4c412cb fix(agent-codex): add three-brain skill to mirror agent template
d298a50 test(paths): make assertions path-separator-agnostic for Windows
332ca07 test(crlf): tolerate Windows CRLF line endings in YAML frontmatter regex
9e73aa4 test(env): scrub inherited CTX_AGENT_DIR / CTX_PROJECT_ROOT in vitest setup
f0e466c chore(agent-codex): in-flight template tools + chmod loop (pre-merge WIP)
62bddb4 Merge remote-tracking branch 'upstream/main' into sync/upstream-2026-05-19
```

11 of 12 platform-neutral; one Windows-gated (ENOSPC test scaffold).

---

## Cross-references

- Pre-merge triage: `orgs/aunnix/agents/codex/workspace/triage-2026-05-13.md`
- Merge plan (v2 + Codex CLI adversarial reconciliation): `orgs/aunnix/agents/codex/workspace/upstream-merge-plan-2026-05-19.md`
- Sibling branch (carrying our pre-merge `5e5cf7f redaction hook` work): `feat/security-redaction-hook` — separate merge gate, not blocking this report.
