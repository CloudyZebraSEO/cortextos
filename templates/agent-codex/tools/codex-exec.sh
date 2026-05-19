#!/usr/bin/env bash
# codex-exec.sh — stdin-clean wrapper around `codex exec` for cortextOS agents.
#
# WHY: `codex exec` in non-interactive Bash will read stdin if stdin is open.
# In the cortextOS agent harness, stdin is usually an open pipe owned by the
# parent, so plain `codex exec "<prompt>"` stalls indefinitely waiting for EOF.
# (Lesson: aurex 2026-05-13 — first stall took 35 min before manual kill.)
#
# This wrapper:
#   1. Closes stdin by default (redirects /dev/null) unless --pipe is passed.
#   2. Applies sensible defaults: --skip-git-repo-check, --sandbox workspace-write.
#   3. --review forces --sandbox read-only (guardrail #1 — a reviewer must not
#      be able to mutate the repo mid-review).
#   4. Refuses to run if the prompt / args / piped stdin reference secret files
#      or contain credential-shaped content (guardrail #2 — secrets never
#      transit an external CLI).
#   5. Adds a timeout safety net (default 600s) and a cleanup trap that kills
#      the codex child if the wrapper itself is interrupted (guardrail #5).
#   6. Routes the call through three-brain output filing if --route is given.
#
# USAGE:
#   codex-exec.sh "<prompt>"                       # default workspace-write call
#   codex-exec.sh --review "<prompt>"              # read-only sandbox (review/audit)
#   codex-exec.sh --pipe "<prompt>" < context.txt  # pipe context on stdin
#   codex-exec.sh --timeout 1200 "<prompt>"        # custom timeout (seconds)
#   codex-exec.sh --route adversarial "<prompt>"   # tag for three-brain log
#   codex-exec.sh --no-defaults "<prompt>"         # skip sandbox/skip-git flags
#   codex-exec.sh --allow-secrets "<prompt>"       # ESCAPE HATCH — bypass the
#                                                  # secrets guard (use only when
#                                                  # you have verified the input)
#
# REQUIRES:  codex CLI installed (codex-cli >= 0.128).

set -euo pipefail

PIPE=0
TIMEOUT=600
ROUTE=""
USE_DEFAULTS=1
REVIEW=0
ALLOW_SECRETS=0
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pipe)          PIPE=1; shift ;;
    --timeout)       TIMEOUT="$2"; shift 2 ;;
    --route)         ROUTE="$2"; shift 2 ;;
    --no-defaults)   USE_DEFAULTS=0; shift ;;
    --review)        REVIEW=1; shift ;;
    --allow-secrets) ALLOW_SECRETS=1; shift ;;
    --sandbox)       EXTRA_ARGS+=("$1" "$2"); shift 2 ;;   # flag-with-value
    --sandbox=*)     EXTRA_ARGS+=("$1"); shift ;;
    --)              shift; EXTRA_ARGS+=("$@"); break ;;
    -*)              EXTRA_ARGS+=("$1"); shift ;;
    *)               break ;;
  esac
done

if [[ $# -eq 0 ]]; then
  echo "codex-exec.sh: missing prompt argument" >&2
  echo "usage: codex-exec.sh [--review] [--pipe] [--timeout S] [--route NAME] \"<prompt>\"" >&2
  exit 64
fi

PROMPT="$1"; shift || true

# --- Secrets guard (guardrail #2) -------------------------------------------
# Refuse to forward secret-file references or credential-shaped content to the
# external codex CLI. Scans the prompt, the extra args, and — for --pipe —
# the buffered stdin content. --allow-secrets is the audited escape hatch.
#
# Patterns (tightened to match real file references, not prose words):
#   - .env / .env.<suffix> / secrets.env  — bounded so ".environment" etc. miss
#   - credentials only when path-shaped (/...credentials) or with an extension
#     (...credentials.json) — bare word "credentials" in prose does NOT trip it
#   - credential-shaped CONTENT: NAME_TOKEN= / NAME_KEY= / NAME_SECRET= /
#     BOT_TOKEN= / API_KEY= / PASSWORD= (KEY=VALUE form = real secret material)
SECRET_FILE_RE='(^|[^[:alnum:]_])(\.env(\.[[:alnum:]_-]+)?([^[:alnum:]_.-]|$)|secrets\.env|/[[:alnum:]_-]*credentials[[:alnum:]_.-]*|[[:alnum:]_-]*credentials[[:alnum:]_-]*\.[[:alnum:]]+)'
SECRET_CONTENT_RE='([[:alnum:]_]*(TOKEN|API_KEY|APIKEY|SECRET|PASSWORD|PASSWD|PRIVATE_KEY)[[:alnum:]_]*[[:space:]]*=|BOT_TOKEN|ALLOWED_USER[[:space:]]*=)'

PIPE_BUFFER=""
if [[ $PIPE -eq 1 ]]; then
  # Buffer stdin so we can scan it before forwarding. Bounded read — codex
  # context is text; if someone pipes gigabytes that is its own problem.
  PIPE_BUFFER="$(cat)"
fi

if [[ $ALLOW_SECRETS -eq 0 ]]; then
  SCAN_TEXT="$PROMPT ${EXTRA_ARGS[*]:-} $PIPE_BUFFER"
  if printf '%s' "$SCAN_TEXT" | grep -Eiq "$SECRET_FILE_RE"; then
    echo "codex-exec.sh: REFUSED — input references a secret file (.env / secrets.env / *credentials*)." >&2
    echo "  Secrets must not transit the codex CLI (guardrail #2). If the reference is" >&2
    echo "  benign and you have verified it, re-run with --allow-secrets." >&2
    exit 77
  fi
  if printf '%s' "$SCAN_TEXT" | grep -Eq "$SECRET_CONTENT_RE"; then
    echo "codex-exec.sh: REFUSED — input contains credential-shaped content (KEY=VALUE secret)." >&2
    echo "  Strip the secret material before sending to codex (guardrail #2)." >&2
    echo "  If this is a false positive, re-run with --allow-secrets." >&2
    exit 77
  fi
fi

# --- Build the command ------------------------------------------------------
# Guardrail #1 — when --review is set, read-only must be UNCONDITIONAL. Strip
# any caller-supplied --sandbox / --full-auto / --dangerously-* from EXTRA_ARGS
# so a later write-enabling flag cannot win last-one-wins parsing in codex.
if [[ $REVIEW -eq 1 && ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  FILTERED_ARGS=()
  skip_next=0
  for a in "${EXTRA_ARGS[@]}"; do
    if [[ $skip_next -eq 1 ]]; then skip_next=0; continue; fi
    case "$a" in
      --sandbox)              skip_next=1; continue ;;   # drops "--sandbox VALUE"
      --sandbox=*)            continue ;;
      --full-auto)            continue ;;
      --dangerously-*)        continue ;;
      *)                      FILTERED_ARGS+=("$a") ;;
    esac
  done
  # Reassign carefully — "${arr[@]:-}" on an empty array yields a single empty
  # string, not an empty array. Guard on length instead.
  if [[ ${#FILTERED_ARGS[@]} -gt 0 ]]; then
    EXTRA_ARGS=("${FILTERED_ARGS[@]}")
  else
    EXTRA_ARGS=()
  fi
fi

CMD=(codex exec)
if [[ $USE_DEFAULTS -eq 1 ]]; then
  CMD+=(--skip-git-repo-check)
fi
# EXTRA_ARGS first, then the sandbox flag LAST so review-mode read-only wins.
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  CMD+=("${EXTRA_ARGS[@]}")
fi
if [[ $REVIEW -eq 1 ]]; then
  CMD+=(--sandbox read-only)
elif [[ $USE_DEFAULTS -eq 1 ]]; then
  CMD+=(--sandbox workspace-write)
fi
CMD+=("$PROMPT")

START_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Optional three-brain logging
LOG_LINE=""
LOG_DIR=""
if [[ -n "$ROUTE" ]]; then
  AGENT="${CTX_AGENT_NAME:-unknown}"
  LOG_DIR="${CTX_FRAMEWORK_ROOT:-$PWD}/orgs/${CTX_ORG:-aunnix}/agents/$AGENT/three-brain-out"
  mkdir -p "$LOG_DIR"
  SANDBOX_TAG=$([[ $REVIEW -eq 1 ]] && echo "read-only" || echo "workspace-write")
  LOG_LINE="[$START_TS] route=codex-$ROUTE sandbox=$SANDBOX_TAG timeout=${TIMEOUT}s"
fi

# --- Cleanup trap (guardrail #5) --------------------------------------------
# If the wrapper is interrupted (SIGINT/SIGTERM) the codex child can orphan.
# Track the child PID and kill its process group on exit-by-signal.
CHILD_PID=""
CLEANUP_DONE=0
cleanup() {
  # Re-entry guard — a second signal during cleanup must not double-kill.
  [[ $CLEANUP_DONE -eq 1 ]] && return
  CLEANUP_DONE=1
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "codex-exec.sh: interrupted — killing codex child $CHILD_PID" >&2
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$CHILD_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

set +e
if [[ $PIPE -eq 1 ]]; then
  # Caller piped context — replay the buffered stdin to codex.
  printf '%s' "$PIPE_BUFFER" | timeout "$TIMEOUT" "${CMD[@]}" &
  CHILD_PID=$!
else
  # Default — close stdin so codex does not stall.
  timeout "$TIMEOUT" "${CMD[@]}" < /dev/null &
  CHILD_PID=$!
fi
wait "$CHILD_PID"
EXIT_CODE=$?
set -e
trap - INT TERM

END_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [[ -n "$LOG_LINE" ]]; then
  echo "$LOG_LINE end=$END_TS exit=$EXIT_CODE" >> "$LOG_DIR/log.md"
fi

if [[ $EXIT_CODE -eq 124 ]]; then
  echo "codex-exec.sh: TIMEOUT after ${TIMEOUT}s — run aborted" >&2
fi

exit $EXIT_CODE
