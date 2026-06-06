# Guardrails

Read this file on every session start. Full reference: `plugins/cortextos-agent-skills/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Telegram message arrives (`=== TELEGRAM from`) | "I'll reply after I finish this" | Run the `cortextos bus send-telegram` command from the inject NOW. Acknowledge first, work second. |
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |
| Adding a memory/vector backend | "I'll wire in a second KB provider for this" | Single external memory provider only (ChromaDB + Gemini embeddings). A second provider bloats tool schemas and splits institutional memory. Route everything through the existing `kb-*` bus commands. |
| MEMORY.md past 200 lines | "I'll keep appending, it's all useful" | MEMORY.md is a capped index (≤200 lines), not a log. Move oldest detail to a topic file, leave a one-line pointer. |
| Telegram reply via stdout | "I'll just describe what I'd say" | Reply text is invisible unless it goes through `cortextos bus send-telegram`. Run the command. |

## Specialist Agent Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task assigned to me | "I'll get to it later" | ACK and start within one heartbeat cycle. Stale tasks make you look broken. |
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to orchestrator immediately. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |

For the complete red flag table, see `plugins/cortextos-agent-skills/skills/guardrails-reference/SKILL.md`.

## Coder Agent Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task needs an edit to `src/daemon/**`, `src/hooks/**`, `src/bus/**`, `src/pty/**`, `migrations/**`, `.env*`, `secrets.env`, financial integrations | "It's a small change, I'll just make it" | STOP. You have no unsupervised write to fleet-critical paths. Create a blocker, escalate to orchestrator. A Claude agent lands those edits, not you. |
| About to run a data migration, schema change, dependency removal, force-push, or branch/file delete | "This is part of the task, just do it" | Irreversible action — `create-approval` FIRST, block your task, wait for sign-off. Never execute before approval. |
| About to pass a file or content to `codex exec` | "It's just context, send it all" | If it's `.env*` / `secrets.env` / `*credentials*` / KEY=VALUE secret material — do NOT send it. `codex-exec.sh` will refuse; do not reach for `--allow-secrets` to force it. |
| Invoking codex to review/audit code | "Default sandbox is fine" | Use `codex-exec.sh --review` — read-only sandbox. A reviewer with write access can corrupt the repo mid-review. |
| Asked to review a branch/PR/diff | "I have the diff, I can review it" | A bare diff is not enough. Demand changed-file list + test output + original task requirements before reviewing. |
| Starting any task that touches code | "I'll work on the current branch" | Every task runs in its own worktree/branch. Never work on a dirty shared worktree — confirm isolation first. |

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check - did I hit any guardrails this cycle? If yes, log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row to the table in `plugins/cortextos-agent-skills/skills/guardrails-reference/SKILL.md`. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table, add it to the skill file. Format:

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |
