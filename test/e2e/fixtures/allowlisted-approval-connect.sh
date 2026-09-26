# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

set -euo pipefail
cli=__NEMOCLAW_ALLOWLISTED_CLI__
sandbox=__NEMOCLAW_ALLOWLISTED_SANDBOX__
trigger_output="$(mktemp)"
request_id_file="$(mktemp)"
trap 'rm -f -- "$trigger_output" "$request_id_file"' EXIT

# Expansion is intentionally deferred to the in-sandbox bash process.
# shellcheck disable=SC2016
"$cli" "$sandbox" exec --timeout 60 -- bash -lc \
  'set -euo pipefail; identity=/sandbox/.openclaw/identity; test -f "$identity/device.json"; rm -f -- "$identity/device.json" "$identity/device-auth.json"'

set +e
"$cli" "$sandbox" exec --timeout 60 -- openclaw agents list --json >"$trigger_output" 2>&1
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
    r"scope upgrade pending approval|device pairing required|pairing required",
    raw,
    re.IGNORECASE,
):
    raise SystemExit("native failure did not report a pending allowlisted request")
request_ids = {
    match.lower()
    for match in re.findall(
        r"\brequestId\s*[:=]\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b",
        raw,
        re.IGNORECASE,
    )
}
if len(request_ids) != 1:
    raise SystemExit(f"native failure reported {len(request_ids)} request IDs")
Path(sys.argv[2]).write_text(next(iter(request_ids)), encoding="utf-8")
PY_REQUEST_ID

request_id="$(cat "$request_id_file")"
{
  printf 'expected_request_id=%q\n' "$request_id"
  cat <<'NEMOCLAW_ALLOWLISTED_APPROVAL'
set -euo pipefail
devices_json="$(mktemp)"
trap 'rm -f -- "$devices_json"' EXIT
openclaw devices list --json >"$devices_json"
python3 - "$devices_json" "$expected_request_id" <<'PY_ALLOWLISTED_STATE'
import json, sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = sys.argv[2].strip().lower()
pending = data.get("pending") or []
paired = data.get("paired") or []
if not isinstance(pending, list) or not isinstance(paired, list):
    raise SystemExit("device state arrays are unavailable")
if any(
    str(item.get("requestId") or "").strip().lower() == expected
    for item in pending
    if isinstance(item, dict)
):
    raise SystemExit("the allowlisted request remains pending after connect")
identity = json.loads(
    Path("/sandbox/.openclaw/identity/device.json").read_text(encoding="utf-8")
)
device_id = str(identity.get("deviceId") or "").strip()
matches = [
    item
    for item in paired
    if isinstance(item, dict)
    and str(item.get("deviceId") or "").strip() == device_id
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
    if isinstance(item, dict)
):
    raise SystemExit("current CLI identity still has a pending request")
print("ISSUE_4462_ALLOWLISTED_GATEWAY_STATE_OK")
PY_ALLOWLISTED_STATE
openclaw agents list --json >/dev/null
echo ISSUE_4462_ALLOWLISTED_RETRY_OK
NEMOCLAW_ALLOWLISTED_APPROVAL
} | "$cli" "$sandbox" connect
