# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

set -euo pipefail
cli=__NEMOCLAW_ALLOWLISTED_CLI__
sandbox=__NEMOCLAW_ALLOWLISTED_SANDBOX__
trigger_output="$(mktemp)"
request_id_file="$(mktemp)"
devices_json="$(mktemp)"
device_id_file="$(mktemp)"
revoke_output="$(mktemp)"
trap 'rm -f -- "$trigger_output" "$request_id_file" "$devices_json" "$device_id_file" "$revoke_output"' EXIT

# Revoke the current device's operator token through OpenClaw's public API so
# the next write-scope command creates a real same-device repair request. This
# remains valid after OpenClaw migrates identity and pairing state to SQLite.
# Expansion is intentionally deferred to the in-sandbox bash process.
# shellcheck disable=SC2016
"$cli" "$sandbox" exec --timeout 60 -- bash -lc \
  'unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD; openclaw devices list --json' \
  >"$devices_json"
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
# Expansion is intentionally deferred to the in-sandbox bash process.
# shellcheck disable=SC2016
"$cli" "$sandbox" exec --timeout 60 -- bash -lc \
  'unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD; openclaw devices revoke --device "$1" --role operator --json' \
  -- "$device_id" >"$revoke_output" 2>&1
revoke_status=$?
set -e
if [ "$revoke_status" -ne 0 ] && ! grep -Eqi 'device token .* denied' "$revoke_output"; then
  echo "ALLOWLISTED_NATIVE_REVOKE_FAILED" >&2
  exit 32
fi

set +e
# Expansion is intentionally deferred to the in-sandbox bash process.
# shellcheck disable=SC2016
"$cli" "$sandbox" exec --timeout 60 -- bash -lc \
  'set +e; unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD; params="$(printf '\''{"key":"agent:main:nemoclaw-e2e-allowlisted-%s-%s","agentId":"main"}'\'' "$$" "$(date +%s)")"; NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 openclaw gateway call sessions.create --params "$params" --json; status=$?; set -e; python3 /tmp/issue-4462-pending-allowlisted-request.py; exit "$status"' \
  >"$trigger_output" 2>&1
trigger_status=$?
set -e
if [ "$trigger_status" -eq 0 ]; then
  echo "ALLOWLISTED_REQUEST_UNEXPECTED_SUCCESS" >&2
  exit 31
fi

python3 - "$trigger_output" "$request_id_file" <<'PY_REQUEST_ID'
import re, sys
from pathlib import Path

raw = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
if not re.search(
    r"scope upgrade pending approval|device pairing required|pairing required|device token .* denied",
    raw,
    re.IGNORECASE,
):
    raise SystemExit("native failure did not report a pending allowlisted request")
request_ids = set(
    re.findall(
        r"^ISSUE_4462_ALLOWLISTED_REQUEST_ID=([0-9a-f-]{36})$",
        raw,
        re.MULTILINE,
    )
)
if len(request_ids) != 1:
    raise SystemExit(f"native failure reported {len(request_ids)} request IDs")
Path(sys.argv[2]).write_text(next(iter(request_ids)), encoding="utf-8")
PY_REQUEST_ID

request_id="$(cat "$request_id_file")"
{
  printf 'expected_request_id=%q\n' "$request_id"
  cat <<'NEMOCLAW_ALLOWLISTED_APPROVAL'
set -euo pipefail
python3 - "$expected_request_id" <<'PY_ALLOWLISTED_STATE'
import importlib.util, sys

helper_path = "/usr/local/lib/nemoclaw/openclaw_pairing_state.py"
spec = importlib.util.spec_from_file_location("nemoclaw_allowlisted_state", helper_path)
if spec is None or spec.loader is None:
    raise SystemExit("canonical pairing-state helper is unavailable")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
records, _metadata = module.read_openclaw_pairing_state(
    "/sandbox/.openclaw", timeout=1
)
identity = records.get("identity")
pending_map = records.get("pending")
paired_map = records.get("paired")
if (
    not isinstance(identity, dict)
    or not isinstance(pending_map, dict)
    or not isinstance(paired_map, dict)
):
    raise SystemExit("canonical pairing state is unavailable")
pending = list(pending_map.values())
paired = list(paired_map.values())
if any(not isinstance(item, dict) for item in pending + paired):
    raise SystemExit("canonical pairing records must be objects")
expected = sys.argv[1].strip().lower()
if any(
    str(item.get("requestId") or "").strip().lower() == expected
    for item in pending
):
    raise SystemExit("the allowlisted request remains pending after connect")
device_id = str(identity.get("deviceId") or "").strip()
matches = [
    item
    for item in paired
    if str(item.get("deviceId") or "").strip() == device_id
]
if not device_id or len(matches) != 1:
    raise SystemExit(
        f"current CLI identity must match one paired device, found {len(matches)}"
    )
device = matches[0]
if device.get("clientId") not in {"cli", "openclaw-cli"} or device.get(
    "clientMode"
) != "cli":
    raise SystemExit("settled device is not an allowlisted CLI identity")


def scope_set(value):
    result = {str(scope).strip() for scope in (value or []) if str(scope).strip()}
    if "operator.write" in result:
        result.add("operator.read")
    return result


approved = scope_set(device.get("approvedScopes")) | scope_set(device.get("scopes"))
tokens = device.get("tokens") or {}
entries = (
    list(tokens.values())
    if isinstance(tokens, dict)
    else tokens
    if isinstance(tokens, list)
    else []
)
active = [
    entry
    for entry in entries
    if isinstance(entry, dict)
    and entry.get("role") == "operator"
    and not entry.get("revokedAtMs")
]
if len(active) != 1:
    raise SystemExit(f"expected one active operator token, found {len(active)}")
required = {"operator.pairing", "operator.read", "operator.write"}
if not required.issubset(approved):
    raise SystemExit("paired device scopes are not active after connect")
if not required.issubset(scope_set(active[0].get("scopes"))):
    raise SystemExit("operator token scopes are not active after connect")
if any(
    str(item.get("deviceId") or "").strip() == device_id
    for item in pending
):
    raise SystemExit("current CLI identity still has a pending request")
print("ISSUE_4462_ALLOWLISTED_GATEWAY_STATE_OK")
PY_ALLOWLISTED_STATE
unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT \
  OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD
params="$(printf '{"key":"agent:main:nemoclaw-e2e-allowlisted-retry-%s-%s","agentId":"main"}' "$$" "$(date +%s)")"
NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \
  openclaw gateway call sessions.create --params "$params" --json >/dev/null
echo ISSUE_4462_ALLOWLISTED_RETRY_OK
NEMOCLAW_ALLOWLISTED_APPROVAL
} | "$cli" "$sandbox" connect
