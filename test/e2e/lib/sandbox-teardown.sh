# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash
#
# Shared sandbox-teardown helper for e2e test scripts. Meant to be sourced
# (not executed directly), so no shebang.
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

_NEMOCLAW_TEARDOWN_SANDBOXES=()

register_sandbox_for_teardown() {
  local name="${1:-}"
  [[ -z "$name" ]] && return 0
  _NEMOCLAW_TEARDOWN_SANDBOXES+=("$name")
}

_nemoclaw_sandbox_teardown() {
  # Run on script EXIT — destroys every registered sandbox and clears the
  # onboard.lock so a subsequent run starts clean even if this one crashed.
  set +e
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null
  local sbx
  for sbx in "${_NEMOCLAW_TEARDOWN_SANDBOXES[@]}"; do
    nemoclaw "$sbx" destroy --yes >/dev/null 2>&1
  done
  set -e
}

trap _nemoclaw_sandbox_teardown EXIT
