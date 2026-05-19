#!/usr/bin/env bash
# worktree-guard.sh — git worktree isolation for the Codex coder agent.
#
# WHY (guardrail #4): every coder-agent task must run in its own worktree/branch.
# Working on a dirty shared checkout means: (a) a review/diff picks up unrelated
# changes, (b) two tasks fight over the same files, (c) a rescue can overwrite
# work in progress. This helper is the single entry point for task-isolated git.
#
# MODES:
#   worktree-guard.sh check
#       Verify it is safe to do code work HERE. exit 0 = clean & safe,
#       exit 1 = dirty worktree (uncommitted changes) — do NOT proceed.
#
#   worktree-guard.sh create <slug>
#       Create an isolated worktree for a task. Branch: coder/<slug>.
#       Path: <repo-parent>/cortextos-worktrees/<slug>. Prints the path.
#       Refuses if the worktree/branch already exists.
#
#   worktree-guard.sh cleanup <slug>
#       Remove the worktree after the task is done. Does NOT delete the branch
#       (so the work is recoverable); prints the branch name for follow-up.
#
#   worktree-guard.sh list
#       Show all coder-agent worktrees.
#
# EXIT: 0 ok | 1 unsafe/dirty | 64 usage | 2 git error

set -euo pipefail

die()  { echo "worktree-guard.sh: $*" >&2; exit 2; }
usage(){ echo "usage: worktree-guard.sh {check|create <slug>|cleanup <slug>|list}" >&2; exit 64; }

command -v git >/dev/null 2>&1 || die "git not found"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repo"

REPO_ROOT="$(git rev-parse --show-toplevel)"
WT_BASE="$(dirname "$REPO_ROOT")/cortextos-worktrees"

MODE="${1:-}"; shift || true

case "$MODE" in
  check)
    # Dirty = any staged/unstaged/untracked change. A coder task must start clean.
    if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
      echo "worktree-guard.sh: UNSAFE — worktree has uncommitted changes:" >&2
      git status --short >&2
      echo "worktree-guard.sh: create an isolated worktree first (worktree-guard.sh create <slug>)." >&2
      exit 1
    fi
    # Warn (do not fail) if this is the PRIMARY worktree — coder work should
    # normally happen in a dedicated one, but a clean primary is not unsafe.
    PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
    if [[ "$REPO_ROOT" == "$PRIMARY" ]]; then
      echo "worktree-guard.sh: OK (clean) — note: this is the PRIMARY worktree." >&2
      echo "  Prefer a dedicated worktree for task work: worktree-guard.sh create <slug>" >&2
    else
      echo "worktree-guard.sh: OK — clean dedicated worktree ($REPO_ROOT)" >&2
    fi
    exit 0
    ;;

  create)
    SLUG="${1:-}"; [[ -n "$SLUG" ]] || usage
    # Sanitize slug — branch/path-safe only.
    if [[ ! "$SLUG" =~ ^[A-Za-z0-9._-]+$ ]]; then
      die "slug must be [A-Za-z0-9._-] only (got: $SLUG)"
    fi
    BRANCH="coder/$SLUG"
    WT_PATH="$WT_BASE/$SLUG"
    if [[ -e "$WT_PATH" ]]; then
      die "worktree path already exists: $WT_PATH"
    fi
    if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
      die "branch already exists: $BRANCH (pick a new slug or clean up the old task)"
    fi
    mkdir -p "$WT_BASE"
    # Clear stale worktree metadata first — a previously-removed worktree can
    # leave registration that blocks path/branch reuse.
    git worktree prune >/dev/null 2>&1 || true
    # New branch off current HEAD, isolated worktree.
    if ! git worktree add -b "$BRANCH" "$WT_PATH" >/dev/null 2>&1; then
      die "git worktree add failed for $WT_PATH"
    fi
    echo "$WT_PATH"
    echo "worktree-guard.sh: created worktree $WT_PATH on branch $BRANCH — cd there to work." >&2
    exit 0
    ;;

  cleanup)
    SLUG="${1:-}"; [[ -n "$SLUG" ]] || usage
    BRANCH="coder/$SLUG"
    WT_PATH="$WT_BASE/$SLUG"
    if [[ ! -d "$WT_PATH" ]]; then
      die "no worktree at $WT_PATH"
    fi
    # Refuse to remove a worktree with uncommitted work — that would lose it.
    if [[ -n "$(git -C "$WT_PATH" status --porcelain 2>/dev/null)" ]]; then
      echo "worktree-guard.sh: REFUSED — $WT_PATH has uncommitted changes." >&2
      echo "  Commit or stash them before cleanup, or you will lose work." >&2
      exit 1
    fi
    # Verify what branch the worktree is actually on — do not assume it is
    # coder/<slug> (the agent may have switched branches inside it).
    ACTUAL_BRANCH="$(git -C "$WT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    # Warn if that branch has commits not yet merged into its upstream/base —
    # "branch kept" is only real recoverability if someone knows to look.
    UNMERGED=""
    if [[ "$ACTUAL_BRANCH" != "?" && "$ACTUAL_BRANCH" != "HEAD" ]]; then
      AHEAD="$(git -C "$WT_PATH" rev-list --count "@{upstream}..HEAD" 2>/dev/null || echo "")"
      if [[ -z "$AHEAD" ]]; then
        # No upstream — compare against the primary branch (main).
        AHEAD="$(git -C "$WT_PATH" rev-list --count "main..HEAD" 2>/dev/null || echo "0")"
      fi
      [[ "${AHEAD:-0}" -gt 0 ]] 2>/dev/null && UNMERGED="$AHEAD"
    fi
    git worktree remove "$WT_PATH" >/dev/null 2>&1 || die "git worktree remove failed"
    git worktree prune >/dev/null 2>&1 || true
    if [[ -n "$UNMERGED" ]]; then
      echo "worktree-guard.sh: removed worktree $WT_PATH." >&2
      echo "  WARNING: branch $ACTUAL_BRANCH has $UNMERGED unmerged commit(s) — do NOT delete it" >&2
      echo "  until that work is merged or explicitly abandoned." >&2
    else
      echo "worktree-guard.sh: removed worktree $WT_PATH (was on $ACTUAL_BRANCH). Branch kept (delete manually if unwanted)." >&2
    fi
    exit 0
    ;;

  list)
    echo "Coder-agent worktrees under $WT_BASE:"
    git worktree list | grep -E "cortextos-worktrees|\[coder/" || echo "  (none)"
    exit 0
    ;;

  *)
    usage
    ;;
esac
