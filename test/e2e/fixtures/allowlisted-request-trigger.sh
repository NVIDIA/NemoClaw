# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

set -euo pipefail
selector_path="${ISSUE_4462_ALLOWLISTED_SELECTOR_PATH:-/tmp/issue-4462-pending-allowlisted-request.py}"
client_state="${ISSUE_4462_ALLOWLISTED_CLIENT_STATE_DIR:-/tmp/issue-4462-allowlisted-client}"
client_config="$client_state/openclaw.json"
bootstrap_output="$(mktemp)"
trigger_output="$(mktemp)"
trap 'rm -f -- "$bootstrap_output" "$trigger_output"' EXIT
unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT \
  OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD
if [ -e "$client_state" ]; then
  echo "allowlisted fixture client state already exists" >&2
  exit 32
fi
install -d -m 0700 -- "$client_state"
printf '%s\n' '{"gateway":{"mode":"local","port":18789,"auth":{}}}' >"$client_config"
chmod 0600 "$client_config"
set +e
NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \
  OPENCLAW_STATE_DIR="$client_state" \
  OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json \
  openclaw devices list --json >"$bootstrap_output" 2>&1
bootstrap_status=$?
set -e
if [ "$bootstrap_status" -ne 0 ]; then
  echo "allowlisted fixture pairing bootstrap failed" >&2
  exit 33
fi
params="$(printf '{"key":"agent:main:nemoclaw-e2e-allowlisted-%s-%s","agentId":"main"}' "$$" "$(date +%s)")"
set +e
NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \
  OPENCLAW_STATE_DIR="$client_state" \
  OPENCLAW_CONFIG_PATH="$client_config" \
  openclaw gateway call sessions.create --params "$params" --json \
  >"$trigger_output" 2>&1
trigger_status=$?
set -e
cat "$trigger_output"
if [ "$trigger_status" -eq 0 ]; then
  echo "ALLOWLISTED_REQUEST_UNEXPECTED_SUCCESS" >&2
  exit 31
fi
OPENCLAW_STATE_DIR=/sandbox/.openclaw python3 "$selector_path"
exit "$trigger_status"
