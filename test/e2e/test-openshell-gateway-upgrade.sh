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
OLD_DOCKER_WRAPPER_DIR=""
OLD_DOCKER_WRAPPER_LOG="/tmp/nemoclaw-e2e-openshell-gateway-old-docker.log"
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
# shellcheck source=test/e2e/lib/openai-compatible-api-proof.sh
source "${SCRIPT_DIR}/lib/openai-compatible-api-proof.sh"
STATE_DIR="${NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR:-$HOME/.local/state/nemoclaw/openshell-docker-gateway}"
PID_FILE="${STATE_DIR}/openshell-gateway.pid"
OLD_NEMOCLAW_REF="${NEMOCLAW_OLD_NEMOCLAW_REF:-v0.0.36}"
OLD_OPENSHELL_VERSION="${NEMOCLAW_OLD_OPENSHELL_VERSION:-0.0.36}"
OLD_SANDBOX_BASE_IMAGE_REF="${NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF:-ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6}"
OLD_OPENCLAW_VERSION="${NEMOCLAW_OLD_OPENCLAW_VERSION:-2026.4.24}"
CURRENT_OPENSHELL_VERSION="${NEMOCLAW_CURRENT_OPENSHELL_VERSION:-0.0.44}"
SURVIVOR_SANDBOX="${NEMOCLAW_GATEWAY_UPGRADE_SURVIVOR_NAME:-e2e-gateway-upgrade-survivor}"
SURVIVOR_MARKER="gateway-upgrade-survivor-$(date +%s)"
SURVIVOR_MARKER_PATH="/sandbox/.openclaw/workspace/nemoclaw-gateway-upgrade-marker"
REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"
FAKE_BASE_URL=""
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

create_old_docker_wrapper() {
  OLD_DOCKER_WRAPPER_DIR="$(mktemp -d)"
  rm -f "$OLD_DOCKER_WRAPPER_LOG"
  cat >"${OLD_DOCKER_WRAPPER_DIR}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
real_docker="${NEMOCLAW_REAL_DOCKER:-/usr/bin/docker}"
base_ref="${NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF:?}"
old_openclaw="${NEMOCLAW_OLD_OPENCLAW_VERSION:?}"
log_file="${NEMOCLAW_OLD_DOCKER_WRAPPER_LOG:-/tmp/nemoclaw-e2e-openshell-gateway-old-docker.log}"
base_tag="ghcr.io/nvidia/nemoclaw/sandbox-base:latest"
if [ "${1:-}" = "pull" ]; then
  for arg in "$@"; do
    if [ "$arg" = "$base_tag" ]; then
      printf 'rewrite pull %s -> %s\n' "$base_tag" "$base_ref" >>"$log_file"
      "$real_docker" pull "$base_ref"
      "$real_docker" tag "$base_ref" "$base_tag"
      exit 0
    fi
  done
fi
if [ "${1:-}" != "build" ]; then
  exec "$real_docker" "$@"
fi

args=()
rewrote_openclaw=0
rewrote_base=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-arg)
      if [ "$#" -ge 2 ] && [ "${2#BASE_IMAGE=}" != "$2" ]; then
        rewrote_base=1
      fi
      if [ "$#" -ge 2 ] && [ "${2#OPENCLAW_VERSION=}" != "$2" ]; then
        args+=("--build-arg" "OPENCLAW_VERSION=${old_openclaw}")
        rewrote_openclaw=1
        printf 'rewrite build-arg %s -> OPENCLAW_VERSION=%s\n' "$2" "$old_openclaw" >>"$log_file"
        shift 2
        continue
      fi
      if [ "$#" -ge 2 ] && [ "${2#BASE_IMAGE=}" != "$2" ]; then
        args+=("--build-arg" "BASE_IMAGE=${base_ref}")
        rewrote_base=1
        printf 'rewrite build-arg %s -> BASE_IMAGE=%s\n' "$2" "$base_ref" >>"$log_file"
        shift 2
        continue
      fi
      ;;
    --build-arg=OPENCLAW_VERSION=*)
      args+=("--build-arg=OPENCLAW_VERSION=${old_openclaw}")
      rewrote_openclaw=1
      printf 'rewrite build-arg %s -> OPENCLAW_VERSION=%s\n' "$1" "$old_openclaw" >>"$log_file"
      shift
      continue
      ;;
    --build-arg=BASE_IMAGE=*)
      args+=("--build-arg=BASE_IMAGE=${base_ref}")
      rewrote_base=1
      printf 'rewrite build-arg %s -> BASE_IMAGE=%s\n' "$1" "$base_ref" >>"$log_file"
      shift
      continue
      ;;
    --build-arg=BASE_IMAGE=*)
      rewrote_base=1
      ;;
  esac
  args+=("$1")
  shift
done
if [ "$rewrote_openclaw" = "0" ]; then
  args+=("--build-arg" "OPENCLAW_VERSION=${old_openclaw}")
  printf 'add build-arg OPENCLAW_VERSION=%s\n' "$old_openclaw" >>"$log_file"
fi
if [ "$rewrote_base" = "0" ]; then
  args+=("--build-arg" "BASE_IMAGE=${base_ref}")
  printf 'add build-arg BASE_IMAGE=%s\n' "$base_ref" >>"$log_file"
fi
exec "$real_docker" "${args[@]}"
EOF
  chmod 755 "${OLD_DOCKER_WRAPPER_DIR}/docker"
}

patch_old_installer_fixture() {
  local installer="$1"
  python3 - "$installer" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = '  legacy_script="${source_root}/install.sh"\n'
insertion = r"""  if [[ -n "${NEMOCLAW_OLD_OPENCLAW_VERSION:-}" && -f "$payload_script" ]]; then
    python3 - "$payload_script" <<'NEMOCLAW_OLD_PAYLOAD_PIN_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = '    spin "Cloning ${_CLI_DISPLAY} source" clone_nemoclaw_ref "$release_ref" "$nemoclaw_src"\n'
hook = r'''    if [[ -n "${NEMOCLAW_OLD_OPENCLAW_VERSION:-}" ]]; then
      python3 - "$nemoclaw_src/Dockerfile" "$NEMOCLAW_OLD_OPENCLAW_VERSION" <<'NEMOCLAW_OLD_DOCKERFILE_PIN_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
version = sys.argv[2]
text = path.read_text(encoding="utf-8")
marker = "RUN set -eu; \\\n    MIN_VER=$(grep -m 1 'min_openclaw_version'"
injection = (
    "# E2E old-upgrade fixture: force the historical OpenClaw before the old Dockerfile's version gate.\n"
    "RUN rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw \\\n"
    f"    && npm install -g --no-audit --no-fund --no-progress \"openclaw@{version}\" \\\n"
    "    && openclaw --version\n\n"
)
if injection not in text:
    if marker not in text:
        raise SystemExit(f"{path}: old OpenClaw version gate not found")
    text = text.replace(marker, injection + marker, 1)
    path.write_text(text, encoding="utf-8")
print(f"INFO: Forced OpenClaw {version} in old upgrade fixture Dockerfile", flush=True)
NEMOCLAW_OLD_DOCKERFILE_PIN_PY
    fi
'''
if hook not in text:
    if needle not in text:
        raise SystemExit(f"{path}: old source clone hook not found")
    text = text.replace(needle, needle + hook, 1)
    path.write_text(text, encoding="utf-8")
NEMOCLAW_OLD_PAYLOAD_PIN_PY
  fi
"""
if insertion not in text:
    if needle not in text:
        raise SystemExit(f"{path}: old bootstrap payload hook not found")
    text = text.replace(needle, needle + insertion, 1)
    path.write_text(text, encoding="utf-8")
PY
}

cleanup() {
  set +e
  stop_fake_openai_compatible_api
  if command -v openshell >/dev/null 2>&1; then
    openshell sandbox delete "$SURVIVOR_SANDBOX" >/dev/null 2>&1 || true
    openshell gateway remove nemoclaw >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
  if [ -n "$OLD_DOCKER_WRAPPER_DIR" ]; then
    rm -rf "$OLD_DOCKER_WRAPPER_DIR"
  fi
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
  printf 'openshell 0.0.44\n'
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
  if grep -q "openshell-driver-vm-aarch64-apple-darwin.tar.gz" "$curl_log"; then
    diag "curl log:"
    cat "$curl_log" 2>/dev/null || true
    rm -rf "$tmp"
    fail "macOS installer still requested the Darwin openshell-driver-vm asset"
  fi

  rm -rf "$tmp"
  pass "macOS OpenShell ${CURRENT_OPENSHELL_VERSION} incomplete install fetches Darwin gateway asset"
}

exercise_macos_vm_driver_entitlement_not_required() {
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
  printf 'openshell 0.0.44\n'
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
    fail "macOS installer still required openshell-driver-vm Hypervisor entitlement"
  fi

  if [ -s "$sign_log" ] && grep -q -- "--force --sign - --entitlements" "$sign_log"; then
    diag "codesign log:"
    cat "$sign_log" 2>/dev/null || true
    rm -rf "$tmp"
    fail "macOS installer still codesigned openshell-driver-vm"
  fi

  if grep -q "Installing OpenShell from release" "$install_out"; then
    diag "installer stdout:"
    cat "$install_out" 2>/dev/null || true
    rm -rf "$tmp"
    fail "macOS installer reinstalled instead of repairing an otherwise complete OpenShell install"
  fi

  rm -rf "$tmp"
  pass "macOS OpenShell ${CURRENT_OPENSHELL_VERSION} installer does not require VM driver Hypervisor entitlement"
}

exercise_macos_docker_rootfs_permission_regression() {
  grep -q "ARG NEMOCLAW_DARWIN_VM_COMPAT=0" Dockerfile \
    || fail "Dockerfile is missing the macOS VM rootfs compatibility ARG"
  grep -Fq "ARG NEMOCLAW_DARWIN_VM_COMPAT=\${sanitizeDockerArg(darwinVmCompat ? \"1\" : \"0\")}" src/lib/onboard/dockerfile-patch.ts \
    || fail "Dockerfile patch helper does not patch the macOS VM rootfs compatibility ARG"
  grep -Fq "const darwinVmCompat = false;" src/lib/onboard/sandbox-dockerfile-patch-flow.ts \
    || fail "onboard does not keep macOS Docker sandbox builds out of the VM rootfs compatibility path"
  grep -q "chmod -R a+rwX /sandbox/.openclaw" Dockerfile \
    || fail "Dockerfile does not relax OpenClaw state permissions for macOS VM rootfs remapping"
  grep -q "ARG NEMOCLAW_DARWIN_VM_COMPAT=0" agents/hermes/Dockerfile \
    || fail "Hermes Dockerfile is missing the macOS VM rootfs compatibility ARG"
  grep -q "chmod -R a+rwX /sandbox/.hermes" agents/hermes/Dockerfile \
    || fail "Hermes Dockerfile does not relax Hermes state permissions for macOS VM rootfs remapping"
  grep -q "chmod a+rw /sandbox/.bashrc /sandbox/.profile" agents/hermes/Dockerfile \
    || fail "Hermes Dockerfile does not relax trusted rc files for macOS VM ownership repair"
  pass "macOS Docker sandbox builds keep VM rootfs compatibility disabled"
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
  export FAKE_OPENAI_HOST="127.0.0.1"
  export FAKE_OPENAI_PORT="0"
  export FAKE_OPENAI_LOG="$MOCK_LOG"
  if start_fake_openai_compatible_api; then
    FAKE_BASE_URL="$FAKE_OPENAI_BASE_URL"
    pass "Compatible endpoint mock is listening at ${FAKE_BASE_URL}"
    return 0
  fi
  fail "compatible endpoint mock did not start"
}

run_installer_payload() {
  local label="$1" ref="$2" installer="$3" log_file="$4"
  info "Running ${label} NemoClaw installer from ${ref}"
  rm -f "$log_file"
  local docker_path_env=()
  if [ -n "$OLD_DOCKER_WRAPPER_DIR" ] && [[ "$label" == old\ * ]]; then
    docker_path_env=(
      PATH="${OLD_DOCKER_WRAPPER_DIR}:$PATH"
      NEMOCLAW_REAL_DOCKER="$(command -v docker)"
      NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF="$OLD_SANDBOX_BASE_IMAGE_REF"
      NEMOCLAW_OLD_OPENCLAW_VERSION="$OLD_OPENCLAW_VERSION"
      NEMOCLAW_OLD_DOCKER_WRAPPER_LOG="$OLD_DOCKER_WRAPPER_LOG"
    )
  fi

  env \
    "${docker_path_env[@]}" \
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
    if [ -f "$OLD_DOCKER_WRAPPER_LOG" ]; then
      diag "old installer docker wrapper activity:"
      cat "$OLD_DOCKER_WRAPPER_LOG" || true
    fi
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
  create_old_docker_wrapper
  info "Pinning old ${OLD_NEMOCLAW_REF} OpenClaw base build to ${OLD_OPENCLAW_VERSION}"
  download_old_curl_installer "$installer"
  patch_old_installer_fixture "$installer"
  run_installer_payload "old ${OLD_NEMOCLAW_REF}" "$OLD_NEMOCLAW_REF" "$installer" "$OLD_INSTALL_LOG"
  if [ -f "$OLD_DOCKER_WRAPPER_LOG" ]; then
    diag "old installer docker wrapper activity:"
    cat "$OLD_DOCKER_WRAPPER_LOG" || true
  fi
  local wrong_old_openclaw
  wrong_old_openclaw="$(
    grep -Eo "OpenClaw [0-9]{4}\\.[0-9]+\\.[0-9]+ is current \\(>= ${OLD_OPENCLAW_VERSION}\\)" "$OLD_INSTALL_LOG" 2>/dev/null \
      | awk '{print $2}' \
      | grep -v "^${OLD_OPENCLAW_VERSION}$" \
      | head -n 1 || true
  )"
  if [ -n "$wrong_old_openclaw" ]; then
    fail "old ${OLD_NEMOCLAW_REF} fixture used OpenClaw ${wrong_old_openclaw} instead of pinned ${OLD_OPENCLAW_VERSION}"
  fi
  if ! grep -q "OpenClaw ${OLD_OPENCLAW_VERSION}\\|openclaw@${OLD_OPENCLAW_VERSION}" "$OLD_INSTALL_LOG" 2>/dev/null; then
    fail "old ${OLD_NEMOCLAW_REF} fixture did not show pinned OpenClaw ${OLD_OPENCLAW_VERSION}"
  fi
  rm -f "$installer"

  if ! openshell --version 2>&1 | grep -q "$OLD_OPENSHELL_VERSION"; then
    fail "old NemoClaw install did not leave OpenShell ${OLD_OPENSHELL_VERSION}: $(openshell --version 2>&1 || true)"
  fi
  pass "Old NemoClaw install selected $(openshell --version)"

  if [ -d "$HOME/.nemoclaw/source/.git" ]; then
    local old_head expected_head
    old_head="$(git -C "$HOME/.nemoclaw/source" rev-parse HEAD 2>/dev/null || true)"
    expected_head="$(git ls-remote https://github.com/NVIDIA/NemoClaw.git "refs/tags/${OLD_NEMOCLAW_REF}" | awk '{print $1}')"
    if [ -z "$old_head" ] || [ "$old_head" != "$expected_head" ]; then
      fail "old installer source is ${old_head:-unknown}, expected ${expected_head:-$OLD_NEMOCLAW_REF}"
    fi
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
  current_ref="${NEMOCLAW_CURRENT_NEMOCLAW_REF:-$(git rev-parse HEAD 2>/dev/null || printf '%s' "${GITHUB_SHA:-}")}"
  [ -n "$current_ref" ] || fail "could not determine current NemoClaw ref"
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
  exercise_macos_vm_driver_entitlement_not_required
  exercise_macos_docker_rootfs_permission_regression
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
exercise_macos_vm_driver_entitlement_not_required
exercise_macos_docker_rootfs_permission_regression
