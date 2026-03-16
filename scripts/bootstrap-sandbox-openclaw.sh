#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

sandbox_name="${1:-}"
if [ -z "$sandbox_name" ]; then
  echo "usage: bootstrap-sandbox-openclaw.sh <sandbox-name>" >&2
  exit 1
fi

info() { printf '  %s\n' "$1"; }
warn() { printf '  WARN: %s\n' "$1" >&2; }
fail() { printf '  ERROR: %s\n' "$1" >&2; exit 1; }

run_in_sandbox() {
  openshell sandbox connect "$sandbox_name" -- nemoclaw-shell "$@"
}

run_setup() {
  info "Initializing OpenClaw config inside sandbox..."
  run_in_sandbox openclaw setup >/dev/null
}

run_gateway_fallback() {
  warn "user-systemd unavailable; starting Gateway directly"
  run_in_sandbox sh -lc '
mkdir -p "$HOME/.openclaw/logs"
if ! openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then
  nohup openclaw gateway run --force >"$HOME/.openclaw/logs/gateway.log" 2>&1 < /dev/null &
fi
for i in 1 2 3 4 5 6 7 8; do
  if openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then
    exit 0
  fi
  sleep 2
done
exit 1
'
}

run_gateway_install() {
  local gateway_json
  info "Installing managed Gateway inside sandbox..."
  gateway_json="$(run_in_sandbox openclaw gateway install --json)"
  printf '%s\n' "$gateway_json"

  GATEWAY_JSON="$gateway_json" python3 - <<'PY'
import json, os, sys

raw = os.environ.get("GATEWAY_JSON", "").strip()
try:
    data = json.loads(raw) if raw else {}
except json.JSONDecodeError:
    print("invalid-json")
    sys.exit(2)

for warning in data.get("warnings", []):
    print(f"warning:{warning}")

if data.get("ok") is True:
    sys.exit(0)

msg = str(data.get("message") or data.get("error") or "")
normalized = msg.lower()
need_fallback = any(token in normalized for token in [
    "systemctl --user unavailable",
    "systemctl not available",
    "systemd user services are required",
    "failed to connect to bus",
    "dbus_session_bus_address",
    "xdg_runtime_dir",
    "system has not been booted with systemd",
])
print(f"fallback:{'1' if need_fallback else '0'}")
print(f"message:{msg}")
sys.exit(1)
PY
}

run_setup

gateway_output="$(run_gateway_install 2>&1)" || gateway_rc=$?
gateway_rc="${gateway_rc:-0}"
printf '%s\n' "$gateway_output"

if [ "$gateway_rc" -eq 0 ]; then
  info "Gateway initialized successfully."
  exit 0
fi

if printf '%s\n' "$gateway_output" | grep -q '^fallback:1$'; then
  run_gateway_fallback || fail "Gateway fallback failed"
  info "Gateway initialized with direct background process."
  exit 0
fi

message="$(printf '%s\n' "$gateway_output" | sed -n 's/^message://p' | tail -1)"
if [ -n "$message" ]; then
  fail "$message"
fi

fail "Gateway initialization failed"
