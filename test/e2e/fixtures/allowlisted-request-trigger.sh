# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

set -euo pipefail
selector_path="${ISSUE_4462_ALLOWLISTED_SELECTOR_PATH:-/tmp/issue-4462-pending-allowlisted-request.py}"
watcher_status_path="${ISSUE_4462_AUTO_PAIR_STATUS_PATH:-/tmp/nemoclaw-auto-pair-status.json}"
devices_json="$(mktemp)"
device_id_file="$(mktemp)"
remove_output="$(mktemp)"
trigger_output="$(mktemp)"
trap 'rm -f -- "$devices_json" "$device_id_file" "$remove_output" "$trigger_output"' EXIT
unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT \
  OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD

# The startup watcher is a separate supported approval owner. Wait for its
# published terminal state so this fixture specifically proves the connect
# recovery path after that owner has naturally reached its configured deadline.
python3 - "$watcher_status_path" <<'PY_WATCHER_STOPPED'
import json, sys, time
from pathlib import Path

status_path = Path(sys.argv[1])
for _attempt in range(46):
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        status = None
    if isinstance(status, dict) and status.get("state") == "stopped":
        break
    time.sleep(1)
else:
    raise SystemExit("auto-pair watcher did not publish its stopped state")
PY_WATCHER_STOPPED

# Remove the current CLI through OpenClaw's public API. Its descriptor-backed
# identity remains in place, so the next write command publishes a real
# same-device repair request rather than a request for an unrelated client.
openclaw devices list --json >"$devices_json"
python3 - "$devices_json" "$device_id_file" <<'PY_DEVICE_ID'
import json, sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
paired = data.get("paired") or []
if not isinstance(paired, list):
    raise SystemExit("paired device state is unavailable")
matches = [
    item
    for item in paired
    if isinstance(item, dict)
    and item.get("clientId") in {"cli", "openclaw-cli"}
    and item.get("clientMode") == "cli"
]
if len(matches) != 1:
    raise SystemExit(f"expected one paired CLI device, found {len(matches)}")
device_id = str(matches[0].get("deviceId") or "").strip()
if not device_id:
    raise SystemExit("paired CLI device has no deviceId")
Path(sys.argv[2]).write_text(device_id, encoding="utf-8")
PY_DEVICE_ID
device_id="$(cat "$device_id_file")"
set +e
openclaw devices remove "$device_id" --json >"$remove_output" 2>&1
remove_status=$?
set -e
if [ "$remove_status" -ne 0 ] && ! grep -Eqi 'device token .* denied' "$remove_output"; then
  cat "$remove_output" >&2
  echo "ALLOWLISTED_NATIVE_REMOVE_FAILED" >&2
  exit 32
fi

params="$(printf '{"key":"agent:main:nemoclaw-e2e-allowlisted-%s-%s","agentId":"main"}' "$$" "$(date +%s)")"
set +e
NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \
  openclaw gateway call sessions.create --params "$params" --json \
  >"$trigger_output" 2>&1
trigger_status=$?
set -e
cat "$trigger_output"
if [ "$trigger_status" -eq 0 ]; then
  echo "ALLOWLISTED_REQUEST_UNEXPECTED_SUCCESS" >&2
  exit 31
fi
python3 "$selector_path"
exit "$trigger_status"
