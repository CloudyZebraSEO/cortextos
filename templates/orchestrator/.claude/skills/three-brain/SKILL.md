---
name: three-brain
description: |
  Auto-routes work to Codex (GPT-5.5) or Gemini 2.5 Pro when the task fits their unique capabilities better than Claude alone. Claude (this agent) stays the driver — the others are tools it calls.

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  HARD RULE — THE NO-SELF-REVIEW LAW (READ THIS FIRST)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  When the user asks Claude to "check / review / look over / proof / verify / audit / sanity-check / second-opinion" ANY work Claude (you) just produced — code, writing, plan, design, edit, anything — this is a MUST-FIRE situation. You MUST route to Codex.

  Claude reviewing Claude's own output is the exact failure mode this skill exists to prevent. Same architecture = same blind spots. A self-review catches nothing meaningful and defeats the entire purpose of the three-brain stack.

  Phrases that MUST trigger Codex review (not exhaustive):
  • "check over your work" / "check your work"
  • "review what you just did" / "review your code" / "review the code you wrote"
  • "look over this" / "give it a once-over" / "go over what you wrote"
  • "is this right?" / "is the code right?" / "anything wrong with this?"
  • "second opinion" / "sanity check" / "double-check" / "proof this"
  • "audit this" / "verify this" / "make sure this works"

  Do NOT silently self-review. Do NOT say "I'll review it inline." Route to Codex via Bash:
    git diff | codex exec --skip-git-repo-check < /dev/null "Review this. Find bugs, risks, missing tests."
  OR for un-tracked code, pipe the file content directly. **NOTE the `< /dev/null`** — without it, `codex exec` may stall waiting on stdin in non-interactive Bash. See aurex MEMORY.md (2026-05-13 Codex CLI stdin lesson).

  After Codex returns, integrate findings into your reply. State at the end: "(Routed via three-brain → Codex review.)"

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FIRE THIS SKILL WHEN (full list):
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • [MUST-FIRE — see above] User asks to review/check/look-over ANY work Claude just produced → Codex review
  • User says "tear apart / sanity check / stress test / find what's wrong / break this / poke holes" → Codex adversarial review
  • User says "I'm stuck / can't figure this out / hand it off / try GPT" OR Claude has failed the same operation 2+ times in a row (same test fail, same error, same loop) → Codex rescue
  • Active edit touches a risky file path (cortextOS-specific paths — see Risk-path detection below) → forced Codex adversarial review BEFORE saying "done" (announce it visibly)
  • Active edit touches a design call with cross-platform implications (Windows vs POSIX path semantics, socket transport, symlink-vs-junction, AF_UNIX vs named pipes) → forced Codex adversarial review before committing
  • Message contains a video file (.mp4 .mov .webm .avi .mkv), audio file (.wav .mp3 .flac .m4a .ogg), PDF >50pg, or YouTube URL → Gemini multimodal (with preprocessing contract — see body)
  • User says "scan the whole repo / find every place X / pattern across the codebase / map the architecture" → Gemini 1M-context whole-repo scan
  • User explicitly invokes high-stakes consensus mode ("ask all three / get cross-architecture consensus / before I commit to this") → all three in parallel with structured output

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DO NOT FIRE FOR:
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • "Explain / what is / how does / walk me through" → Claude direct
  • "Write / draft / create / build / make" on non-risky paths → Claude direct (but if user immediately says "now check over your work" — MUST-FIRE applies)
  • "Edit / change / update / refactor" on non-risky paths → Claude direct
  • "Plan / brainstorm / outline / design" on non-risky paths → Claude direct
  • "Review my notes / review my draft email / review my Telegram reply" — content the user wrote, not Claude → Claude direct (different from Claude's own code)
  • Conversational chat, status questions, file ops, git/bash/grep, normal Q&A → Claude direct
  • Orchestration coordination (sending messages to scout/oracle, dispatching tasks, reading inbox) → Claude direct — that is core aurex work, not code review territory

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  AMBIGUITY RULE — biased toward firing
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  When uncertain whether a phrase fires the skill on Claude's own work: FIRE IT. The cost of a 20-second Codex call is small. The cost of a self-review missing a real bug is huge. Bias toward firing on review verbs targeted at Claude's output. Bias toward staying asleep on review verbs targeted at user's own non-code content.

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  POSITIVE EXAMPLES (MUST FIRE):
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    "yo check over your work" → Codex review (MUST-FIRE)
    "review the code you just wrote" → Codex review (MUST-FIRE)
    "is this right?" (after Claude wrote code) → Codex review (MUST-FIRE)
    "tear this apart" → Codex adversarial review
    "is the daemon hook change safe?" → Codex adversarial review (hooks path = forced)
    "watch this clip and tell me what's interesting" + video → gemini @./file
    "I've tried this 3 times, you're not getting it" → Codex rescue
    "find every place we hit the Printify API" → Gemini repo scan

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  NEGATIVE EXAMPLES (STAY ASLEEP):
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    "explain how the daemon scheduler works" → Claude
    "refactor this README section" (non-risky path) → Claude
    "draft me a Telegram update for Steven" → Claude
    "review my morning-brief outline" (user's content, not Claude's code) → Claude
    "look up what we decided about Moss & Menace pricing" → recall, not three-brain
    "dispatch task X to scout" → Claude direct (orchestrator core work)
---

# Three-Brain Auto-Router

A single skill that routes work invisibly. Three brains, one terminal:

- **Claude** = builder, driver, orchestrator harness — stays in front of the user the whole time
- **Codex (GPT-5.5)** = reviewer, second brain, rescue
- **Gemini 2.5 Pro** = eyes, ears, long-context — handles anything Claude literally cannot see or hear

## Startup self-check (run once per session, before first route)

Before the first route fires in a session, verify the tooling. If anything's missing, announce it once, fall back gracefully, and don't retry every turn.

```bash
codex --version 2>&1 | head -1   # expect: codex-cli 0.128+
gemini --version 2>&1 | head -1  # expect: 0.40+
```

If `codex` is missing → Codex routes unavailable. Tell the user once: *"Codex CLI not found — review/rescue routes off until installed."* Continue without those routes.

If `gemini` is missing → Gemini routes unavailable. Tell the user the same way. Continue without those routes.

## Codex CLI invocation contract (cortextOS environment)

**Always redirect stdin to /dev/null** when invoking `codex exec` in non-interactive Bash. Without it, codex may stall reading from an open stdin pipe (lesson learned 2026-05-13 — first stall took 35 minutes before recovery).

```bash
# CORRECT — explicit stdin close
codex exec --skip-git-repo-check --sandbox workspace-write < /dev/null "<prompt>"

# CORRECT — explicit content pipe
echo "<context>" | codex exec --skip-git-repo-check --sandbox workspace-write "<prompt>"

# WRONG — open stdin in non-interactive Bash hangs
codex exec --skip-git-repo-check "<prompt>"
```

If a codex invocation appears stuck (no file changes + memory dropping to idle after ~5 min), kill it via PowerShell `Stop-Process -Id <pid> -Force` and either retry with the corrected pattern or do the edit manually.

## Announcement protocol (REQUIRED for all forced routes)

Whenever the skill fires a route the user did NOT explicitly request — i.e. **risk-path detection** or **failure-counter rescue** — announce it in **one line BEFORE running**. The user must be able to interrupt with one word.

Format:

```
[three-brain] routing to Codex (adversarial-review) — risk path: src/hooks/
[three-brain] handing off to Codex rescue — Claude failed same test 2× in a row
[three-brain] consulting Gemini — cross-architecture design call on Windows-AF_UNIX
```

For routes the user explicitly asked for ("yo check this") — no announcement needed. They asked, just do it.

## Failure-detection rule (HARD)

This is a deterministic counter, not a vibe. After Claude attempts the same operation and fails:

- **2× same test failure on same code path** → MUST invoke Codex rescue. Not optional. Announce it.
- **2× same error on same shell command** → MUST invoke Codex rescue. Announce it.
- **2× same edit re-tried with no progress** → MUST invoke Codex rescue. Announce it.

Reset the counter only when (a) the test/build passes, (b) the user changes the goal, or (c) the user explicitly says "keep trying."

When invoking rescue, send full context: the failing output, what's been tried, the relevant files.

```bash
cat <context-bundle> | codex exec --skip-git-repo-check --sandbox workspace-write "rescue: [task]. Claude has tried 2x and failed. Full context attached."
```

## Gemini preprocessing contract

Long media must be prepped before sending to Gemini — raw 2-hour videos blow rate limits and produce noise.

**Video pipeline:**

```bash
# 1. Acquire (if YouTube URL)
yt-dlp -f "best[ext=mp4][height<=720]" "<url>" -o /tmp/three-brain/in.mp4

# 2. Cap duration (default: 120s for demos, 600s for analysis)
ffmpeg -t 120 -i /tmp/three-brain/in.mp4 /tmp/three-brain/clip.mp4 -y

# 3. Send with explicit ask for TIMESTAMPED findings
gemini -p "Analyze frame-by-frame. Return findings as a timestamped list: [MM:SS] event. Cover: graphics, lower-thirds, transitions, on-screen text, speaker actions. Cap output at 800 words." @/tmp/three-brain/clip.mp4
```

**Audio pipeline:** same as above without the video step.

**PDF pipeline:**

```bash
# Cap page count for very long docs (qpdf optional — fall back to copy)
qpdf --pages input.pdf 1-100 -- /tmp/three-brain/doc.pdf 2>/dev/null || cp input.pdf /tmp/three-brain/doc.pdf
gemini -p "Extract: key claims, data tables, chart findings, page-numbered. Cap at 1000 words." @/tmp/three-brain/doc.pdf
```

**Whole-codebase scan:**

```bash
gemini -p "Find every place X. Return file:line list." @./src @./scripts @./tests
```

Always demand **timestamps, page numbers, or file:line citations** in the output — don't accept a flat summary.

## Risk-path detection (cortextOS-specific, path-based, not keyword-based)

Codex's review is forced — without the user asking — when an active edit touches any of these. Adapted for the cortextOS / aunnix surface area:

```
**/.env*                              # any env file (BOT_TOKEN, ALLOWED_USER, API keys)
**/secrets.env                        # org-level secrets file
orgs/*/secrets.env                    # org credentials (printify, tiktok, gemini, etc.)
**/printify-credentials*              # financial integration creds
**/tiktok-shop-credentials*           # financial integration creds
src/daemon/**                         # daemon = orchestrates entire fleet
src/hooks/**                          # hooks fire on lifecycle events; bug = silent fleet failure
src/bus/**                            # inter-agent messaging core
src/pty/**                            # agent runtime (claude/codex/hermes spawn)
src/cli/add-agent*                    # agent creation — wrong scaffold = unbootable agent
orgs/*/agents/*/config.json           # per-agent config; wrong crons/runtime = agent down
orgs/*/agents/*/crons.json            # daemon-loaded cron defs; wrong = silent failure
orgs/aunnix/tools/printify.mjs        # has the dual-flag write protection; financial actions
orgs/aunnix/tools/tiktok-*            # TikTok Shop integrations; financial
orgs/aunnix/brand/**                  # live-shop brand assets
**/migrations/**                      # DB schema changes (Supabase migrations)
templates/**/SKILL.md                 # skills propagate to every new agent — high blast radius
```

Keywords alone (daemon, secrets, hooks) in casual chat do NOT trigger forced review — it has to be an active edit on the file paths.

## Risk-by-reversibility rule

Even task verbs that normally don't fire (refactor/plan/explain/design) DO fire if the target is irreversible or high-blast-radius:

- "Refactor the bus message handler" → fires Codex review (src/bus/**)
- "Plan the Printify write-enable flow" → fires Codex review (financial integration)
- "Design the new daemon hook for crash recovery" → fires Codex review (src/hooks/**)
- "Update the agent template's SKILL.md" → fires Codex review (templates/** — affects every future agent)

Verb is irrelevant if the target is risky.

## Cross-platform design-call route (aurex-specific addition)

When an edit forces a Windows-vs-POSIX design call (path separators, sockets, symlinks, line endings, process semantics), forced route:

1. Codex adversarial review of the proposed approach
2. If the design touches *both* product behavior AND test assumptions → also Gemini consensus on whether the design preserves Linux/Mac behavior bit-for-bit

This matches Steven directive 2026-05-13: "when fixing Windows issues, be sure not to do anything that might break the MacOs or Linux implementations."

## Parallel consensus mode (high-stakes)

Only when explicitly invoked: *"ask all three / before I commit to this / cross-architecture consensus."*

All three answer the SAME question. Claude does not summarize a vibe-consensus — it forces structured output:

```
Recommendation: <one line>
Blocking risks: <bullet list>
Assumptions: <bullet list>
Confidence: low / medium / high
Tests required to verify: <bullet list>
```

Each model returns this template. Claude diffs them: where they agree, where they disagree, and adjudicates *by evidence*, not by averaging.

## Output filing (cortextOS-specific)

Anything the skill produces goes to `orgs/aunnix/agents/<agent>/three-brain-out/<YYYY-MM-DD>-<slug>/`. Per-agent so each agent's review log is auditable in its own home dir.

```
orgs/aunnix/agents/aurex/three-brain-out/2026-05-13-codex-windows-compat/
  ├── input.txt          # what the user/aurex asked
  ├── gemini-analysis.md # Gemini's output (if used)
  ├── claude-output.md   # what Claude (aurex) produced
  ├── codex-review.md    # Codex's review
  └── log.md             # one-line summary, dated
```

Append to `orgs/aunnix/agents/<agent>/three-brain-out/log.md` (agent root-level) every time the skill runs:

```
[2026-05-13 14:30] route=codex-adversarial target=fix/codex-windows-compat files=2
```

That's the compounding ledger.

## Calling patterns (Bash, since slash commands aren't issuable from inside a skill)

```bash
# Codex review (note < /dev/null)
git diff | codex exec --skip-git-repo-check --sandbox workspace-write "Review this diff. Flag bugs, risks, missing tests. Be specific."

# Codex adversarial (note < /dev/null)
git diff | codex exec --skip-git-repo-check --sandbox workspace-write "Adversarial review. Challenge the design. Find what's wrong. Prove it's broken."

# Codex rescue
cat <bundle> | codex exec --skip-git-repo-check --sandbox workspace-write "Rescue mode. Claude tried 2x and failed. Solve it from scratch."

# Gemini multimodal
gemini -p "<focused ask with output format>" @./file

# Gemini whole-codebase
gemini -p "<focused question>. Return file:line list." @./src @./scripts @./tests
```

## Stay-asleep rules (explicit)

Do not fire on:
- Casual conversation, greetings, status checks
- Any question Claude can answer directly without external help
- Sending Telegram replies, ACKing inbox messages, normal orchestration
- "Recall / what did we decide / look up" → memory layer, not three-brain
- "Save this / wrap up / log this" → log-event / daily memory, not three-brain
- "What's my strategy on X" → MEMORY.md / KB, not three-brain
- Heartbeat work, cron tick handling, status queries
- Any task already in another skill's territory

When uncertain: **stay asleep**. Under-firing is fine. Over-firing breaks trust and burns API calls.
