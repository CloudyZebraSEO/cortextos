#!/usr/bin/env bash
# three-brain-file.sh — safe output filing for three-brain artifacts.
#
# WHY (guardrail #8): three-brain output filing persists prompts, diffs, and
# review text to orgs/<org>/agents/<agent>/three-brain-out/. Those artifacts
# can contain secrets (a diff that touches a config, a prompt that pasted a
# token) and the per-agent output path is not guaranteed to exist. This helper
# is the single safe path to file an artifact:
#   1. Verifies/creates the target directory.
#   2. Scrubs credential-shaped content before writing.
#   3. Refuses to write if scrubbing detected secrets AND --strict is set.
#
# USAGE:
#   three-brain-file.sh <src-file> <target-dir> <out-name>
#   three-brain-file.sh --strict <src-file> <target-dir> <out-name>
#   cat content | three-brain-file.sh - <target-dir> <out-name>
#
#   --strict : if any secret is found, refuse to file at all (exit 77) instead
#              of filing the scrubbed version. Use for high-sensitivity tasks.
#
# EXIT: 0 ok (filed, possibly scrubbed) | 64 usage | 77 strict-refusal | 1 io

set -euo pipefail

STRICT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --) shift; break ;;
    -)  break ;;                       # bare "-" = stdin source, not a flag
    -*) echo "three-brain-file.sh: unknown flag $1" >&2; exit 64 ;;
    *)  break ;;
  esac
done

if [[ $# -ne 3 ]]; then
  echo "usage: three-brain-file.sh [--strict] <src-file|-> <target-dir> <out-name>" >&2
  exit 64
fi

SRC="$1"
TARGET_DIR="$2"
OUT_NAME="$3"

# --- read source ------------------------------------------------------------
if [[ "$SRC" == "-" ]]; then
  CONTENT="$(cat)"
else
  if [[ ! -f "$SRC" ]]; then
    echo "three-brain-file.sh: source file not found: $SRC" >&2
    exit 1
  fi
  CONTENT="$(cat "$SRC")"
fi

# --- scrub credential-shaped content ----------------------------------------
# Replace KEY=VALUE secret material and known token shapes with a redaction
# marker. Conservative on prose (targets shapes, not every uppercase word) but
# broad on known provider key prefixes. NOTE: this cannot catch split or
# obfuscated secrets (token broken across lines, base64-wrapped .env) — it is
# a backstop, not a guarantee. Strip secrets at the source.
SCRUBBED="$(printf '%s' "$CONTENT" | sed -E \
  -e 's/([[:alnum:]_]*(TOKEN|API_KEY|APIKEY|SECRET|PASSWORD|PASSWD|PRIVATE_KEY)[[:alnum:]_]*[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' \
  -e 's/(BOT_TOKEN[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' \
  -e 's/(ALLOWED_USER[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' \
  -e 's#(sk-ant-[A-Za-z0-9_-]{12,})#[REDACTED-KEY]#g' \
  -e 's#(sk-proj-[A-Za-z0-9_-]{12,})#[REDACTED-KEY]#g' \
  -e 's#(sk-[A-Za-z0-9]{16,})#[REDACTED-KEY]#g' \
  -e 's#(sk_live_[A-Za-z0-9]{12,})#[REDACTED-KEY]#g' \
  -e 's#(sk_test_[A-Za-z0-9]{12,})#[REDACTED-KEY]#g' \
  -e 's#(github_pat_[A-Za-z0-9_]{20,})#[REDACTED-KEY]#g' \
  -e 's#(ghp_[A-Za-z0-9]{20,})#[REDACTED-KEY]#g' \
  -e 's#(gho_[A-Za-z0-9]{20,})#[REDACTED-KEY]#g' \
  -e 's#(xox[baprs]-[A-Za-z0-9-]{8,})#[REDACTED-KEY]#g' \
  -e 's#(AIza[A-Za-z0-9_-]{20,})#[REDACTED-KEY]#g' \
  -e 's#((AKIA|ASIA)[A-Z0-9]{16})#[REDACTED-KEY]#g' \
  -e 's#([0-9]{8,10}:[A-Za-z0-9_-]{30,})#[REDACTED-TG-TOKEN]#g' \
  -e 's#(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})#[REDACTED-JWT]#g' \
  -e 's#-----BEGIN [A-Z ]*PRIVATE KEY-----#[REDACTED-PEM-BLOCK]#g' \
)"

REDACTIONS=0
if [[ "$SCRUBBED" != "$CONTENT" ]]; then
  REDACTIONS=1
fi

if [[ $REDACTIONS -eq 1 && $STRICT -eq 1 ]]; then
  echo "three-brain-file.sh: REFUSED (--strict) — secret material detected in artifact." >&2
  echo "  Not filing $OUT_NAME. Strip secrets at the source and retry." >&2
  exit 77
fi

# --- verify/create target dir ----------------------------------------------
# Restrictive perms so a filed artifact is not world-readable, and refuse to
# write through a symlink (a pre-created symlink at the target is a redirect
# attack vector). Symlink checks run BEFORE mkdir -p — mkdir -p on an existing
# symlink-to-dir succeeds silently and would mask the redirect.
umask 077
if [[ -L "$TARGET_DIR" ]]; then
  echo "three-brain-file.sh: REFUSED — target dir is a symlink: $TARGET_DIR" >&2
  exit 1
fi
OUT_PATH="$TARGET_DIR/$OUT_NAME"
if [[ -L "$OUT_PATH" ]]; then
  echo "three-brain-file.sh: REFUSED — target is a symlink: $OUT_PATH" >&2
  exit 1
fi
if ! mkdir -p "$TARGET_DIR" 2>/dev/null; then
  echo "three-brain-file.sh: cannot create target dir: $TARGET_DIR" >&2
  exit 1
fi
# Re-check after mkdir -p in case the dir was created through a symlinked parent.
if [[ -L "$TARGET_DIR" ]]; then
  echo "three-brain-file.sh: REFUSED — target dir is a symlink: $TARGET_DIR" >&2
  exit 1
fi
if ! printf '%s\n' "$SCRUBBED" > "$OUT_PATH" 2>/dev/null; then
  echo "three-brain-file.sh: write failed: $OUT_PATH" >&2
  exit 1
fi

if [[ $REDACTIONS -eq 1 ]]; then
  echo "three-brain-file.sh: filed $OUT_PATH (secret material was redacted)" >&2
else
  echo "three-brain-file.sh: filed $OUT_PATH" >&2
fi
exit 0
