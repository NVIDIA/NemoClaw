# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

set -euo pipefail
cli=__NEMOCLAW_ALLOWLISTED_CLI__
sandbox=__NEMOCLAW_ALLOWLISTED_SANDBOX__
request_id=__NEMOCLAW_ALLOWLISTED_REQUEST_ID__
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
