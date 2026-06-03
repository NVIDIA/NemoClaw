#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared sandbox-teardown helper for e2e test scripts. Meant to be sourced;
# the shebang and executable bit satisfy repo shell-file conventions.
#
# Why: the nightly Brev launchable is reused across runs, and any test that
# exits before cleaning up its sandbox leaves a dangling k8s pod + netns +
# volume behind. Over time these accumulate and can push subsequent runs into
# "sandbox already exists but is not ready" states that block onboard.
#
# Usage (place after SANDBOX_NAME is defined):
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
#   register_sandbox_for_teardown "$SANDBOX_NAME"
#
# Multiple sandboxes: call register_sandbox_for_teardown once per sandbox.
#
# Local-dev escape hatch: set NEMOCLAW_E2E_KEEP_SANDBOX=1 to skip the destroy
# on exit so the sandbox survives for post-mortem inspection.

_NEMOCLAW_TEARDOWN_SANDBOXES=()

register_sandbox_for_teardown() {
  local name="${1:-}"
  [[ -z "$name" ]] && return 0
  _NEMOCLAW_TEARDOWN_SANDBOXES+=("$name")
}

_nemoclaw_sandbox_teardown() {
  # Run on script EXIT — destroys every registered sandbox.
  #
  # Intentionally does NOT unlink ~/.nemoclaw/onboard.lock: that lock is
  # global and ownership-aware (acquireOnboardLock in src/lib/onboard-session.ts
  # verifies PID liveness and inode before cleaning up a stale lock), so an
  # unconditional rm here could unlink a concurrent run's live lock on a
  # shared machine. A crashed process leaves a stale lock that the next
  # onboard cleans up automatically.
  if [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]]; then
    return 0
  fi
  set +e
  local sbx
  for sbx in "${_NEMOCLAW_TEARDOWN_SANDBOXES[@]}"; do
    nemoclaw "$sbx" destroy --yes >/dev/null 2>&1
  done
  set -e
}

trap _nemoclaw_sandbox_teardown EXIT
