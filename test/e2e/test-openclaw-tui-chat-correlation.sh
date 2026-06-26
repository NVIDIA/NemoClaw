#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Validation-only E2E for release-blocker close calls:
#   #2603 - previous TUI/chat message disappears after reconnect/scroll
#   #3145 - rapid sequential TUI messages duplicate or arrive out of order
#
# The Vitest live harness drives OpenClaw's gateway websocket directly against a
# real sandbox. This wrapper creates a fresh cloud-backed OpenClaw sandbox first
# so CI evidence is not dependent on a developer machine's stale sandbox state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-openclaw-tui-correlation}"
INSTALL_LOG="${E2E_OPENCLAW_TUI_CORRELATION_INSTALL_LOG:-/tmp/nemoclaw-e2e-openclaw-tui-correlation-install.log}"
GATEWAY_LOG_EXPORT="${E2E_OPENCLAW_TUI_CORRELATION_GATEWAY_LOG:-/tmp/nemoclaw-e2e-openclaw-tui-correlation-gateway.log}"

# The workflow uploads GATEWAY_LOG_EXPORT on any job failure. Clear that path
# before install/onboard steps so early pre-Vitest failures cannot publish a
# stale or hand-created raw diagnostic from a previous attempt.
bash "${SCRIPT_DIR}/lib/export-redacted-openclaw-gateway-log.sh" --clear "$GATEWAY_LOG_EXPORT"

# shellcheck disable=SC2329 # invoked indirectly by the EXIT trap
cleanup() {
  if [ "${NEMOCLAW_E2E_SKIP_CLEANUP:-0}" = "1" ]; then
    return
  fi
  SANDBOX_NAME="$SANDBOX_NAME" bash "${SCRIPT_DIR}/e2e-cloud-experimental/cleanup.sh" --verify >/dev/null 2>&1 || true
}
trap cleanup EXIT

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export E2E_CLOUD_ONBOARD_INSTALL_LOG="$INSTALL_LOG"
export NEMOCLAW_E2E_KEEP_SANDBOX=1
export NEMOCLAW_NON_INTERACTIVE="${NEMOCLAW_NON_INTERACTIVE:-1}"
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-1}"
export NEMOCLAW_RECREATE_SANDBOX="${NEMOCLAW_RECREATE_SANDBOX:-1}"

bash "${SCRIPT_DIR}/test-cloud-onboard-e2e.sh"

# Pick up PATH changes from the public installer in this shell.
# shellcheck source=test/e2e/lib/install-path-refresh.sh
. "${SCRIPT_DIR}/lib/install-path-refresh.sh"
nemoclaw_refresh_install_env
nemoclaw_ensure_local_bin_on_path
export PATH="/usr/local/bin:${HOME}/.local/bin:${PATH}"

openclaw_version="$(
  openshell sandbox exec --name "$SANDBOX_NAME" -- openclaw --version 2>&1 || true
)"
echo "Sandbox OpenClaw version: ${openclaw_version}"
if ! grep -Fq "2026.5.27" <<<"$openclaw_version"; then
  echo "Expected fresh sandbox to run OpenClaw 2026.5.27" >&2
  exit 1
fi

cd "$REPO"

if [ ! -x ./node_modules/.bin/vitest ]; then
  echo "Restoring repository dev dependencies for the live Vitest harness"
  npm ci --include=dev
fi

vitest_status=0
NEMOCLAW_ISSUE_2603_LIVE=1 \
  NEMOCLAW_ISSUE_2603_SANDBOX="$SANDBOX_NAME" \
  ./node_modules/.bin/vitest run test/openclaw-tui-chat-correlation.test.ts --reporter=verbose \
  || vitest_status=$?

# On failure, export the in-sandbox gateway log before cleanup destroys the
# sandbox: it records why the gateway aborted or delayed chat.send runs, which
# the websocket capture alone cannot explain (#4881).
if [ "$vitest_status" -ne 0 ]; then
  echo "Vitest failed (exit ${vitest_status}); exporting redacted sandbox gateway log to ${GATEWAY_LOG_EXPORT}"
  # Redact before printing or artifact upload: this live gateway can hold
  # hosted-inference keys, gateway auth tokens, headers, and prompt content.
  # Fail closed: if redaction fails, the helper removes the upload path and
  # this wrapper skips printing diagnostics.
  if bash "${SCRIPT_DIR}/lib/export-redacted-openclaw-gateway-log.sh" "$SANDBOX_NAME" "$GATEWAY_LOG_EXPORT"; then
    echo "==== redacted openclaw gateway log (tail) ===="
    cat "$GATEWAY_LOG_EXPORT" || true
    echo "==== end redacted openclaw gateway log ===="
  else
    echo "Gateway log redaction failed; removed raw and redacted gateway log artifacts" >&2
  fi
fi

exit "$vitest_status"
