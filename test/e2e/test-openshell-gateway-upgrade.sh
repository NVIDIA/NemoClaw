#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Regression coverage for PR #3001 upgrade installs:
# 1. If a user already has a working claw on the previous OpenShell release,
#    the current install/onboard path must back up the old claw before replacing
#    the incompatible OpenShell gateway, recreate it under the current gateway,
#    restore durable agent state, and leave the same agent type running.
# 2. If a macOS arm64 user already has the current OpenShell CLI but not the
#    standalone openshell-gateway binary, the installer must fetch the Darwin
#    gateway asset instead of accepting the incomplete CLI-only install.

set -euo pipefail

LOG_FILE="/tmp/nemoclaw-e2e-openshell-gateway-upgrade.log"
INSTALL_LOG="/tmp/nemoclaw-e2e-openshell-gateway-install.log"
OLD_INSTALL_LOG="/tmp/nemoclaw-e2e-openshell-gateway-old-install.log"
CURRENT_INSTALL_LOG="/tmp/nemoclaw-e2e-openshell-gateway-current-install.log"
START_LOG="/tmp/nemoclaw-e2e-openshell-gateway-start.log"
GATEWAY_LOG="/tmp/nemoclaw-e2e-openshell-gateway-process.log"
MOCK_LOG="/tmp/nemoclaw-e2e-openshell-gateway-compatible-mock.log"
exec > >(tee "$LOG_FILE") 2>&1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
diag() { echo -e "${YELLOW}[DIAG]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  diag "openshell status: $(openshell status 2>&1 || true)"
  diag "gateway info: $(openshell gateway info -g nemoclaw 2>&1 || true)"
  diag "pid file: $(cat "$PID_FILE" 2>/dev/null || echo missing)"
  if command -v openshell >/dev/null 2>&1 && [ -n "${SURVIVOR_SANDBOX:-}" ]; then
    diag "survivor agent state: $(survivor_agent_probe 2>&1 || true)"
    diag "survivor agent log tail:"
    openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- \
      sh -lc 'tail -40 /tmp/nemoclaw-e2e-agent.log 2>/dev/null || true' 2>/dev/null || true
  fi
  diag "gateway log tail:"
  tail -100 "$GATEWAY_LOG" 2>/dev/null || true
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATE_DIR="${NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR:-$HOME/.local/state/nemoclaw/openshell-docker-gateway}"
PID_FILE="${STATE_DIR}/openshell-gateway.pid"
OLD_NEMOCLAW_REF="${NEMOCLAW_OLD_NEMOCLAW_REF:-v0.0.36}"
OLD_OPENSHELL_VERSION="${NEMOCLAW_OLD_OPENSHELL_VERSION:-0.0.36}"
CURRENT_OPENSHELL_VERSION="${NEMOCLAW_CURRENT_OPENSHELL_VERSION:-0.0.39}"
SURVIVOR_SANDBOX="${NEMOCLAW_GATEWAY_UPGRADE_SURVIVOR_NAME:-e2e-gateway-upgrade-survivor}"
SURVIVOR_MARKER="gateway-upgrade-survivor-$(date +%s)"
SURVIVOR_MARKER_PATH="/sandbox/.openclaw/workspace/nemoclaw-gateway-upgrade-marker"
REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"
FAKE_BASE_URL=""
FAKE_MOCK_PID=""
SURVIVOR_AGENT_PID=""

load_shell_path() {
  if [ -f "$HOME/.bashrc" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.bashrc" 2>/dev/null || true
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
  if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
}

survivor_agent_probe() {
  local probe
  # shellcheck disable=SC2016
  probe='pid="$(cat /tmp/nemoclaw-e2e-agent.pid 2>/dev/null || true)"; [ -n "$pid" ] || exit 1; kill -0 "$pid" 2>/dev/null || exit 1; counter="$(sed -n "s/^[^ ]* \([0-9][0-9]*\).*/\1/p" /tmp/nemoclaw-e2e-agent.heartbeat 2>/dev/null | head -1)"; cmdline="$(tr "\000" " " <"/proc/${pid}/cmdline" 2>/dev/null || true)"; case "$cmdline" in *nemoclaw-e2e-agent*) ;; *) exit 1 ;; esac; printf "%s %s %s\n" "$pid" "${counter:-0}" "$cmdline"'
  openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- sh -lc "$probe"
}

wait_for_survivor_agent_ready() {
  for _i in $(seq 1 60); do
    if survivor_agent_probe >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

survivor_agent_pid() {
  survivor_agent_probe | awk '{print $1}'
}

survivor_agent_counter() {
  survivor_agent_probe | awk '{print $2}'
}

cleanup_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  set +e
  cleanup_pid "$FAKE_MOCK_PID"
  if command -v openshell >/dev/null 2>&1; then
    openshell sandbox delete "$SURVIVOR_SANDBOX" >/dev/null 2>&1 || true
    openshell gateway remove nemoclaw >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
}
trap cleanup EXIT

exercise_macos_gateway_installer_regression() {
  local tmp fake_bin curl_log install_out install_err
  tmp="$(mktemp -d)"
  fake_bin="$tmp/bin"
  curl_log="$tmp/curl.log"
  install_out="$tmp/install.out"
  install_err="$tmp/install.err"
  mkdir -p "$fake_bin"

  cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-m" ]; then
  printf 'arm64\n'
else
  printf 'Darwin\n'
fi
EOF

  cat >"$fake_bin/openshell" <<'EOF'
#!/usr/bin/env bash
# request-body-credential-rewrite
# websocket-credential-rewrite
if [ "${1:-}" = "--version" ]; then
  printf 'openshell 0.0.39\n'
  exit 0
fi
exit 99
# request-body-credential-rewrite websocket-credential-rewrite
EOF

  cat >"$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

  cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
    break
  fi
  prev="$arg"
done
printf '%s\n' "$*" >>"$NEMOCLAW_FAKE_CURL_LOG"
if [ -n "$out" ]; then
  printf 'fake payload\n' >"$out"
fi
exit 0
EOF

  chmod +x "$fake_bin"/*

  if PATH="$fake_bin:/usr/bin:/bin" \
    NEMOCLAW_OPENSHELL_CHANNEL=stable \
    NEMOCLAW_FAKE_CURL_LOG="$curl_log" \
    bash scripts/install-openshell.sh >"$install_out" 2>"$install_err"; then
    rm -rf "$tmp"
    fail "macOS incomplete OpenShell install unexpectedly succeeded with fake payloads"
  fi

  if ! grep -q "missing Docker-driver binaries" "$install_out"; then
    diag "installer stdout:"
    cat "$install_out"
    diag "installer stderr:"
    cat "$install_err"
    rm -rf "$tmp"
    fail "macOS installer did not detect missing openshell-gateway"
  fi

  if ! grep -q "openshell-gateway-aarch64-apple-darwin.tar.gz" "$curl_log"; then
    diag "curl log:"
    cat "$curl_log" 2>/dev/null || true
    rm -rf "$tmp"
    fail "macOS installer did not request the Darwin openshell-gateway asset"
  fi
  if ! grep -q "openshell-driver-vm-aarch64-apple-darwin.tar.gz" "$curl_log"; then
    diag "curl log:"
    cat "$curl_log" 2>/dev/null || true
    rm -rf "$tmp"
    fail "macOS installer did not request the Darwin openshell-driver-vm asset"
  fi

  rm -rf "$tmp"
  pass "macOS OpenShell ${CURRENT_OPENSHELL_VERSION} incomplete install fetches Darwin gateway and VM driver assets"
}

exercise_macos_vm_driver_entitlement_repair() {
  local tmp fake_bin state_file sign_log install_out install_err
  tmp="$(mktemp -d)"
  fake_bin="$tmp/bin"
  state_file="$tmp/codesign-state"
  sign_log="$tmp/codesign.log"
  install_out="$tmp/install.out"
  install_err="$tmp/install.err"
  mkdir -p "$fake_bin"

  cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-m" ]; then
  printf 'arm64\n'
else
  printf 'Darwin\n'
fi
EOF

  cat >"$fake_bin/openshell" <<'EOF'
#!/usr/bin/env bash
# request-body-credential-rewrite
# websocket-credential-rewrite
if [ "${1:-}" = "--version" ]; then
  printf 'openshell 0.0.39\n'
  exit 0
fi
exit 99
# request-body-credential-rewrite websocket-credential-rewrite
EOF

  cat >"$fake_bin/openshell-gateway" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat >"$fake_bin/openshell-driver-vm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat >"$fake_bin/codesign" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-d" ]; then
  if [ -f "$NEMOCLAW_FAKE_CODESIGN_STATE" ]; then
    printf '%s\n' '<plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>'
  fi
  exit 0
fi
printf '%s\n' "$*" >>"$NEMOCLAW_FAKE_CODESIGN_LOG"
: >"$NEMOCLAW_FAKE_CODESIGN_STATE"
exit 0
EOF

  chmod +x "$fake_bin"/*

  if ! PATH="$fake_bin:/usr/bin:/bin" \
    NEMOCLAW_OPENSHELL_CHANNEL=stable \
    NEMOCLAW_FAKE_CODESIGN_LOG="$sign_log" \
    NEMOCLAW_FAKE_CODESIGN_STATE="$state_file" \
    bash scripts/install-openshell.sh >"$install_out" 2>"$install_err"; then
    diag "installer stdout:"
    cat "$install_out" 2>/dev/null || true
    diag "installer stderr:"
    cat "$install_err" 2>/dev/null || true
    rm -rf "$tmp"
    fail "macOS installer did not repair missing openshell-driver-vm Hypervisor entitlement"
  fi

  if ! grep -q -- "--force --sign - --entitlements" "$sign_log"; then
    diag "codesign log:"
    cat "$sign_log" 2>/dev/null || true
    rm -rf "$tmp"
    fail "macOS installer did not codesign openshell-driver-vm with entitlements"
  fi

  if grep -q "Installing OpenShell from release" "$install_out"; then
    diag "installer stdout:"
    cat "$install_out" 2>/dev/null || true
    rm -rf "$tmp"
    fail "macOS installer reinstalled instead of repairing an otherwise complete OpenShell install"
  fi

  rm -rf "$tmp"
  pass "macOS OpenShell ${CURRENT_OPENSHELL_VERSION} installer repairs missing VM driver Hypervisor entitlement"
}

exercise_macos_vm_rootfs_permission_regression() {
  grep -q "ARG NEMOCLAW_DARWIN_VM_COMPAT=0" Dockerfile \
    || fail "Dockerfile is missing the macOS VM rootfs compatibility ARG"
  grep -Fq "NEMOCLAW_DARWIN_VM_COMPAT=\${darwinVmCompat" src/lib/onboard.ts \
    || fail "onboard does not patch the macOS VM rootfs compatibility ARG"
  grep -q 'process.platform === "darwin"' src/lib/onboard.ts \
    || fail "onboard does not enable macOS VM rootfs compatibility for Darwin sandbox builds"
  grep -q "chmod -R a+rwX /sandbox/.openclaw" Dockerfile \
    || fail "Dockerfile does not relax OpenClaw state permissions for macOS VM rootfs remapping"
  pass "macOS VM sandbox builds enable rootfs ownership compatibility"
}

wait_for_survivor_ready() {
  for _i in $(seq 1 60); do
    if openshell sandbox list 2>/dev/null | grep -q "${SURVIVOR_SANDBOX}.*Ready"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

start_compatible_endpoint_mock() {
  local tmp port_file
  tmp="$(mktemp -d)"
  port_file="${tmp}/port"
  rm -f "$MOCK_LOG"

  python3 - "$port_file" "$MOCK_LOG" <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port_file = sys.argv[1]
log_file = sys.argv[2]

class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _log(self, message):
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(message + "\n")
            fh.flush()

    def log_message(self, _fmt, *_args):
        return

    def do_GET(self):
        self._log(f"GET {self.path}")
        if self.path in ("/v1/models", "/models"):
            self._send(200, {"data": [{"id": "test-model", "object": "model"}]})
            return
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        self._log(f"POST {self.path} {body[:200].decode('utf-8', 'replace')}")
        if self.path in ("/v1/chat/completions", "/chat/completions"):
            self._send(200, {
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop",
                }],
            })
            return
        if self.path in ("/v1/responses", "/responses"):
            self._send(200, {
                "id": "resp-test",
                "object": "response",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "ok"}],
                }],
            })
            return
        self._send(404, {"error": {"message": "not found"}})

server = HTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w", encoding="utf-8") as fh:
    fh.write(str(server.server_port))
server.serve_forever()
PY
  FAKE_MOCK_PID="$!"

  for _i in $(seq 1 30); do
    if [ -s "$port_file" ]; then
      FAKE_BASE_URL="http://127.0.0.1:$(cat "$port_file")/v1"
      if curl -sf "${FAKE_BASE_URL}/models" >/dev/null 2>&1; then
        rm -rf "$tmp"
        pass "Compatible endpoint mock is listening at ${FAKE_BASE_URL}"
        return 0
      fi
    fi
    sleep 1
  done
  rm -rf "$tmp"
  fail "compatible endpoint mock did not start"
}

run_installer_payload() {
  local label="$1" ref="$2" installer="$3" log_file="$4"
  info "Running ${label} NemoClaw installer from ${ref}"
  rm -f "$log_file"
  env \
    COMPATIBLE_API_KEY=dummy \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE=1 \
    NEMOCLAW_BOOTSTRAP_PAYLOAD=1 \
    NEMOCLAW_INSTALL_REF="$ref" \
    NEMOCLAW_INSTALL_TAG="$ref" \
    NEMOCLAW_PROVIDER=custom \
    NEMOCLAW_ENDPOINT_URL="$FAKE_BASE_URL" \
    NEMOCLAW_MODEL=test-model \
    NEMOCLAW_SANDBOX_NAME="$SURVIVOR_SANDBOX" \
    NEMOCLAW_POLICY_MODE=skip \
    NEMOCLAW_DASHBOARD_PORT= \
    CHAT_UI_URL= \
    bash "$installer" --non-interactive --yes-i-accept-third-party-software \
    >"$log_file" 2>&1 || {
    diag "${label} installer log tail:"
    tail -120 "$log_file" 2>/dev/null || true
    fail "${label} NemoClaw installer failed"
  }
  load_shell_path
}

download_old_curl_installer() {
  local target="$1"
  curl -fsSL "https://raw.githubusercontent.com/NVIDIA/NemoClaw/${OLD_NEMOCLAW_REF}/install.sh" \
    -o "$target"
  chmod 755 "$target"
}

install_old_nemoclaw_and_claw() {
  local installer
  installer="$(mktemp)"
  download_old_curl_installer "$installer"
  run_installer_payload "old ${OLD_NEMOCLAW_REF}" "$OLD_NEMOCLAW_REF" "$installer" "$OLD_INSTALL_LOG"
  rm -f "$installer"

  if ! openshell --version 2>&1 | grep -q "$OLD_OPENSHELL_VERSION"; then
    fail "old NemoClaw install did not leave OpenShell ${OLD_OPENSHELL_VERSION}: $(openshell --version 2>&1 || true)"
  fi
  pass "Old NemoClaw install selected $(openshell --version)"

  if [ -d "$HOME/.nemoclaw/source/.git" ]; then
    local old_head expected_head
    old_head="$(git -C "$HOME/.nemoclaw/source" rev-parse HEAD 2>/dev/null || true)"
    expected_head="$(git ls-remote https://github.com/NVIDIA/NemoClaw.git "refs/tags/${OLD_NEMOCLAW_REF}" | awk '{print $1}')"
    [ -n "$old_head" ] && [ "$old_head" = "$expected_head" ] \
      || fail "old installer source is ${old_head:-unknown}, expected ${expected_head:-$OLD_NEMOCLAW_REF}"
    pass "Old NemoClaw source is ${OLD_NEMOCLAW_REF} (${old_head:0:12})"
  fi

  wait_for_survivor_ready || fail "survivor sandbox did not become Ready before gateway upgrade"
  if nemoclaw list 2>&1 | grep -Fq "$SURVIVOR_SANDBOX"; then
    pass "Old NemoClaw install registered survivor claw ${SURVIVOR_SANDBOX}"
  else
    fail "old NemoClaw install did not register survivor claw ${SURVIVOR_SANDBOX}"
  fi
}

start_survivor_agent_in_existing_claw() {
  info "Starting survivor agent inside old NemoClaw claw"
  openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- \
    sh -lc "mkdir -p /sandbox/.openclaw/workspace && printf '%s\n' '$SURVIVOR_MARKER' >'$SURVIVOR_MARKER_PATH'" \
    || fail "failed to write survivor marker before gateway upgrade"

  local agent_payload remote_setup
  agent_payload="$(
    cat <<'AGENT' | base64 | tr -d '\n'
#!/bin/sh
set -eu
pid_file="/tmp/nemoclaw-e2e-agent.pid"
heartbeat_file="/tmp/nemoclaw-e2e-agent.heartbeat"
events_file="/tmp/nemoclaw-e2e-agent.events"
printf '%s\n' "$$" >"$pid_file"
printf 'started %s\n' "$$" >>"$events_file"
counter=0
trap 'printf "stopped %s\n" "$$" >>"$events_file"; exit 0' TERM INT
while true; do
  counter=$((counter + 1))
  printf '%s %s %s\n' "$$" "$counter" "$(date +%s)" >"$heartbeat_file"
  sleep 1
done
AGENT
  )"
  remote_setup="printf '%s' '$agent_payload' | base64 -d >/tmp/nemoclaw-e2e-agent; chmod 755 /tmp/nemoclaw-e2e-agent; rm -f /tmp/nemoclaw-e2e-agent.pid /tmp/nemoclaw-e2e-agent.heartbeat /tmp/nemoclaw-e2e-agent.events /tmp/nemoclaw-e2e-agent.log; nohup /tmp/nemoclaw-e2e-agent >/tmp/nemoclaw-e2e-agent.log 2>&1 &"

  openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- sh -lc "$remote_setup" \
    || fail "failed to start survivor agent before gateway upgrade"
  wait_for_survivor_agent_ready || fail "survivor agent did not become healthy before gateway upgrade"
  SURVIVOR_AGENT_PID="$(survivor_agent_pid)"
  [ -n "$SURVIVOR_AGENT_PID" ] || fail "survivor agent pid was empty before gateway upgrade"

  pass "Old NemoClaw claw has live agent activity (pid ${SURVIVOR_AGENT_PID}) before gateway upgrade"
}

install_current_nemoclaw_upgrade() {
  local current_ref
  current_ref="${GITHUB_SHA:-$(git rev-parse HEAD)}"
  run_installer_payload "current ${current_ref:0:12}" "$current_ref" "${REPO_ROOT}/scripts/install.sh" "$CURRENT_INSTALL_LOG"
  grep -Fq "Accepted experimental OpenShell gateway upgrade" "$CURRENT_INSTALL_LOG" \
    || fail "current installer did not exercise the experimental OpenShell gateway upgrade acceptance path"

  if ! openshell --version 2>&1 | grep -q "$CURRENT_OPENSHELL_VERSION"; then
    fail "current NemoClaw install did not upgrade OpenShell to ${CURRENT_OPENSHELL_VERSION}: $(openshell --version 2>&1 || true)"
  fi
  pass "Current NemoClaw install selected $(openshell --version)"

  local status_output
  status_output="$(openshell status 2>&1 || true)"
  if ! grep -q "Version:.*${CURRENT_OPENSHELL_VERSION}" <<<"$status_output"; then
    diag "openshell status after current install:"
    printf '%s\n' "$status_output"
    fail "gateway server did not report OpenShell ${CURRENT_OPENSHELL_VERSION} after upgrade"
  fi
  pass "Gateway server reports OpenShell ${CURRENT_OPENSHELL_VERSION} after upgrade"

  if grep -Fq "Pre-upgrade backup: 1 backed up, 0 failed, 0 skipped" "$CURRENT_INSTALL_LOG"; then
    pass "Current installer backed up the old running claw before replacing OpenShell"
  else
    diag "current installer backup lines:"
    grep -n "Pre-upgrade backup\\|Backing up\\|Skipping '${SURVIVOR_SANDBOX}'" "$CURRENT_INSTALL_LOG" || true
    fail "current installer did not back up the old running claw before replacing OpenShell"
  fi
}

assert_survivor_sandbox_after_upgrade() {
  local agent_check marker
  info "Verifying survivor sandbox after OpenShell gateway upgrade"
  wait_for_survivor_ready || fail "survivor sandbox is not Ready after gateway upgrade"

  marker="$(
    openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- \
      cat "$SURVIVOR_MARKER_PATH" 2>/dev/null || true
  )"
  [ "$marker" = "$SURVIVOR_MARKER" ] \
    || fail "survivor marker changed after gateway upgrade: got '${marker}'"
  pass "Durable OpenClaw workspace state was restored after gateway upgrade"

  agent_check="$(
    openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- \
      sh -lc 'command -v openclaw >/dev/null && test -s /sandbox/.openclaw/openclaw.json && openclaw --version 2>/dev/null' \
      || true
  )"
  [ -n "$agent_check" ] || fail "OpenClaw agent is not installed/configured after gateway upgrade"
  pass "OpenClaw agent is installed and configured after gateway upgrade"

  if [ -f "$REGISTRY_FILE" ] && grep -Fq "\"${SURVIVOR_SANDBOX}\"" "$REGISTRY_FILE"; then
    pass "NemoClaw registry retained survivor sandbox after gateway upgrade"
  else
    fail "NemoClaw registry lost survivor sandbox after gateway upgrade"
  fi

  local list_output
  if list_output="$(nemoclaw list 2>&1)" && grep -Fq "$SURVIVOR_SANDBOX" <<<"$list_output"; then
    pass "nemoclaw list still shows survivor sandbox after gateway upgrade"
  else
    fail "nemoclaw list does not show survivor sandbox after gateway upgrade: ${list_output:0:200}"
  fi

  pass "Survivor claw state remained reachable after OpenShell gateway upgrade"
}

cd "$REPO_ROOT"
load_shell_path

if [ "$(uname -s)" != "Linux" ]; then
  exercise_macos_gateway_installer_regression
  exercise_macos_vm_driver_entitlement_repair
  exercise_macos_vm_rootfs_permission_regression
  pass "Skipping live Docker-driver gateway restart regression on non-Linux host"
  exit 0
fi

info "Preparing real old-install upgrade scenario"
rm -f "$INSTALL_LOG" "$OLD_INSTALL_LOG" "$CURRENT_INSTALL_LOG" "$START_LOG" "$GATEWAY_LOG"
start_compatible_endpoint_mock
install_old_nemoclaw_and_claw
start_survivor_agent_in_existing_claw

info "Running current NemoClaw installer/onboard against old working claw"
install_current_nemoclaw_upgrade
assert_survivor_sandbox_after_upgrade
pass "Current NemoClaw installer upgraded old ${OLD_NEMOCLAW_REF} claw, restored state, and kept OpenClaw running on OpenShell ${CURRENT_OPENSHELL_VERSION}"

exercise_macos_gateway_installer_regression
exercise_macos_vm_driver_entitlement_repair
exercise_macos_vm_rootfs_permission_regression
