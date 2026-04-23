#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# e2e-timeout.sh — shared timeout detection, self-wrap, and run_with_timeout
#
# Source this file near the top of any E2E test script, AFTER `set -euo pipefail`
# (or `set -uo pipefail`) and BEFORE any commands that need timeout protection.
#
# Required before sourcing:
#   NEMOCLAW_E2E_DEFAULT_TIMEOUT — per-script default (seconds). Falls back to
#                                  $NEMOCLAW_E2E_TIMEOUT_SECONDS if set by the
#                                  caller, or this default if not.
#
# Exported after sourcing:
#   TIMEOUT_CMD          — "timeout", "gtimeout", or "" (empty when bypassed)
#   run_with_timeout()   — helper: run_with_timeout <seconds> <cmd> [args...]
#
# Environment knobs (set by caller / CI):
#   NEMOCLAW_E2E_NO_TIMEOUT=1       — skip the self-wrap AND run commands bare
#   NEMOCLAW_E2E_TIMEOUT_SECONDS    — override the per-script default
#   NEMOCLAW_E2E_TIMEOUT_WRAPPED=1  — (internal) prevents recursive exec
# =============================================================================

# ── Detect timeout binary ────────────────────────────────────────────────────
TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
fi

# ── Self-wrap the calling script under the overall timeout ────────────────────
if [ "${NEMOCLAW_E2E_NO_TIMEOUT:-0}" != "1" ] && [ "${NEMOCLAW_E2E_TIMEOUT_WRAPPED:-0}" != "1" ]; then
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-${NEMOCLAW_E2E_DEFAULT_TIMEOUT:-900}}"
  if [ -n "$TIMEOUT_CMD" ]; then
    export NEMOCLAW_E2E_TIMEOUT_WRAPPED=1
    # Re-exec the *calling* script (not this helper) under $TIMEOUT_CMD.
    # $0 and $@ are inherited from the caller because this file is sourced.
    exec "$TIMEOUT_CMD" -s TERM "$TIMEOUT_SECONDS" "$0" "$@"
  else
    echo "ERROR: 'timeout' not found. Install coreutils (macOS: 'brew install coreutils')" >&2
    echo "       or bypass with NEMOCLAW_E2E_NO_TIMEOUT=1" >&2
    exit 127
  fi
fi

# ── Per-command timeout helper ────────────────────────────────────────────────
# Usage: run_with_timeout <seconds> <command> [args...]
#
# Runs <command> under $TIMEOUT_CMD when timeouts are enabled; runs it bare
# when NEMOCLAW_E2E_NO_TIMEOUT=1.  Avoids the foot-gun where an empty
# $TIMEOUT_CMD turns `$TIMEOUT_CMD 60 ssh …` into `60 ssh …`.
run_with_timeout() {
  local seconds="$1"
  shift
  if [ "${NEMOCLAW_E2E_NO_TIMEOUT:-0}" != "1" ] && [ -n "$TIMEOUT_CMD" ]; then
    "$TIMEOUT_CMD" "$seconds" "$@"
  else
    "$@"
  fi
}
