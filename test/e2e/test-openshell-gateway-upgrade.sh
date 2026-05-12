#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Regression coverage for PR #3001 upgrade installs:
# 1. If a user already has a working claw on the previous OpenShell release,
#    the current install/onboard path must upgrade OpenShell, restart the stale
#    gateway on the current supervisor image, and keep the existing sandbox
#    reachable. This guards the curl|bash upgrade shape that installs the new
#    NemoClaw and then immediately runs onboarding against the existing claw.
# 2. If a macOS arm64 user already has the OpenShell 0.0.37 CLI but not the
#    standalone openshell-gateway binary, the installer must fetch the Darwin
#    gateway asset instead of accepting the incomplete CLI-only install.

set -euo pipefail

LOG_FILE="/tmp/nemoclaw-e2e-openshell-gateway-upgrade.log"
INSTALL_LOG="/tmp/nemoclaw-e2e-openshell-gateway-install.log"
START_LOG="/tmp/nemoclaw-e2e-openshell-gateway-start.log"
GATEWAY_LOG="/tmp/nemoclaw-e2e-openshell-gateway-process.log"
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
OLD_OPENSHELL_VERSION="${NEMOCLAW_OLD_OPENSHELL_VERSION:-0.0.36}"
CURRENT_OPENSHELL_VERSION="${NEMOCLAW_CURRENT_OPENSHELL_VERSION:-0.0.37}"
STALE_IMAGE="ghcr.io/nvidia/openshell/supervisor:${OLD_OPENSHELL_VERSION}"
EXPECTED_IMAGE=""
SURVIVOR_SANDBOX="${NEMOCLAW_GATEWAY_UPGRADE_SURVIVOR_NAME:-e2e-gateway-upgrade-survivor}"
SURVIVOR_MARKER="gateway-upgrade-survivor-$(date +%s)"
REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"
OLD_OPENSHELL_DIR=""
CURRENT_OPENSHELL_DIR=""
SURVIVOR_AGENT_PID=""
SURVIVOR_AGENT_COUNTER_BEFORE="0"

OLD_PID=""
NEW_PID=""

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

process_env_value() {
  local pid="$1" key="$2"
  tr '\0' '\n' <"/proc/${pid}/environ" 2>/dev/null \
    | awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }'
}

remove_path_entry() {
  local remove="$1" entry new_path=""
  IFS=':' read -r -a path_entries <<<"$PATH"
  for entry in "${path_entries[@]}"; do
    [ "$entry" = "$remove" ] && continue
    if [ -z "$new_path" ]; then
      new_path="$entry"
    else
      new_path="${new_path}:$entry"
    fi
  done
  export PATH="$new_path"
}

linux_release_arch_label() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x86_64' ;;
    aarch64 | arm64) printf 'aarch64' ;;
    *) fail "unsupported Linux architecture: $(uname -m)" ;;
  esac
}

download_release_asset() {
  local release_tag="$1" asset_name="$2" dest_dir="$3"
  if command -v gh >/dev/null 2>&1; then
    if GH_PROMPT_DISABLED=1 GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
      gh release download "$release_tag" --repo NVIDIA/OpenShell \
        --pattern "$asset_name" --dir "$dest_dir" --clobber 2>/dev/null; then
      return 0
    fi
  fi
  curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/download/${release_tag}/${asset_name}" \
    -o "${dest_dir}/${asset_name}"
}

verify_release_asset() {
  local tmpdir="$1" asset_name="$2" checksum_file="$3"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$tmpdir" && grep -F "$asset_name" "$checksum_file" | sha256sum -c -) \
      || fail "SHA-256 checksum verification failed for ${asset_name}"
  else
    (cd "$tmpdir" && grep -F "$asset_name" "$checksum_file" | shasum -a 256 -c -) \
      || fail "SHA-256 checksum verification failed for ${asset_name}"
  fi
}

install_openshell_cli_release_to_dir() {
  local version="$1" target_dir="$2" label="${3:-release}" tmpdir arch_label asset_name checksum_file
  mkdir -p "$target_dir"
  tmpdir="$(mktemp -d)"
  arch_label="$(linux_release_arch_label)"
  asset_name="openshell-${arch_label}-unknown-linux-musl.tar.gz"
  checksum_file="openshell-checksums-sha256.txt"

  info "Installing real OpenShell ${version} CLI into temporary ${label} bin"
  download_release_asset "v${version}" "$asset_name" "$tmpdir"
  download_release_asset "v${version}" "$checksum_file" "$tmpdir"
  verify_release_asset "$tmpdir" "$asset_name" "$checksum_file"
  tar xzf "${tmpdir}/${asset_name}" -C "$tmpdir"
  install -m 755 "$tmpdir/openshell" "${target_dir}/openshell"
  rm -rf "$tmpdir"

  pass "Temporary ${label} OpenShell CLI ready: $("${target_dir}/openshell" --version)"
}

install_driver_bins_release_to_dir() {
  local version="$1" target_dir="$2" label="${3:-release}" tmpdir arch_label asset_name checksum_file
  mkdir -p "$target_dir"
  tmpdir="$(mktemp -d)"
  arch_label="$(linux_release_arch_label)"

  info "Installing OpenShell ${version} Docker-driver binaries into temporary ${label} bin"
  for asset_name in \
    "openshell-gateway-${arch_label}-unknown-linux-gnu.tar.gz" \
    "openshell-sandbox-${arch_label}-unknown-linux-gnu.tar.gz"; do
    case "$asset_name" in
      openshell-gateway-*) checksum_file="openshell-gateway-checksums-sha256.txt" ;;
      openshell-sandbox-*) checksum_file="openshell-sandbox-checksums-sha256.txt" ;;
      *) fail "unknown driver asset ${asset_name}" ;;
    esac
    download_release_asset "v${version}" "$asset_name" "$tmpdir"
    download_release_asset "v${version}" "$checksum_file" "$tmpdir"
    verify_release_asset "$tmpdir" "$asset_name" "$checksum_file"
    tar xzf "${tmpdir}/${asset_name}" -C "$tmpdir"
  done

  install -m 755 "$tmpdir/openshell-gateway" "${target_dir}/openshell-gateway"
  install -m 755 "$tmpdir/openshell-sandbox" "${target_dir}/openshell-sandbox"
  rm -rf "$tmpdir"
  pass "Temporary ${label} Docker-driver binaries ready"
}

assert_current_openshell_selected() {
  local version_output
  version_output="$(openshell --version 2>&1 || true)"
  if ! grep -q "$CURRENT_OPENSHELL_VERSION" <<<"$version_output"; then
    fail "PATH still resolves openshell to '${version_output}', expected ${CURRENT_OPENSHELL_VERSION}"
  fi
  command -v openshell-gateway >/dev/null 2>&1 || fail "openshell-gateway not found after upgrade"
  command -v openshell-sandbox >/dev/null 2>&1 || fail "openshell-sandbox not found after upgrade"
  pass "Current OpenShell selected after upgrade: ${version_output}"
}

survivor_agent_probe() {
  # shellcheck disable=SC2016
  openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- sh -lc '
pid="$(cat /tmp/nemoclaw-e2e-agent.pid 2>/dev/null || true)"
[ -n "$pid" ] || exit 1
kill -0 "$pid" 2>/dev/null || exit 1
counter="$(sed -n "s/^[^ ]* \([0-9][0-9]*\).*/\1/p" /tmp/nemoclaw-e2e-agent.heartbeat 2>/dev/null | head -1)"
cmdline="$(tr "\000" " " <"/proc/${pid}/cmdline" 2>/dev/null || true)"
case "$cmdline" in
  *nemoclaw-e2e-agent*) ;;
  *) exit 1 ;;
esac
printf "%s %s %s\n" "$pid" "${counter:-0}" "$cmdline"
'
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
  cleanup_pid "$OLD_PID"
  cleanup_pid "$NEW_PID"
  if command -v openshell >/dev/null 2>&1; then
    openshell sandbox delete "$SURVIVOR_SANDBOX" >/dev/null 2>&1 || true
    openshell gateway remove nemoclaw >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
  [ -z "$OLD_OPENSHELL_DIR" ] || rm -rf "$OLD_OPENSHELL_DIR"
  [ -z "$CURRENT_OPENSHELL_DIR" ] || rm -rf "$CURRENT_OPENSHELL_DIR"
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
if [ "${1:-}" = "--version" ]; then
  printf 'openshell 0.0.37\n'
  exit 0
fi
exit 99
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

  rm -rf "$tmp"
  pass "macOS OpenShell 0.0.37 incomplete install fetches the Darwin gateway asset"
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

create_survivor_sandbox() {
  local testdir
  info "Creating survivor sandbox before OpenShell gateway upgrade"
  openshell sandbox delete "$SURVIVOR_SANDBOX" >/dev/null 2>&1 || true

  testdir="$(mktemp -d)"
  cat >"${testdir}/nemoclaw-e2e-agent" <<'AGENT'
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
  cat >"${testdir}/Dockerfile" <<'DOCKERFILE'
FROM alpine:3.20
RUN adduser -D -h /sandbox sandbox && mkdir -p /sandbox && chown -R sandbox:sandbox /sandbox
COPY nemoclaw-e2e-agent /usr/local/bin/nemoclaw-e2e-agent
RUN chmod 755 /usr/local/bin/nemoclaw-e2e-agent
USER sandbox
WORKDIR /sandbox
CMD ["sh", "-lc", "tail -f /dev/null"]
DOCKERFILE

  openshell sandbox create --name "$SURVIVOR_SANDBOX" --from "${testdir}/Dockerfile" --gateway nemoclaw --no-tty \
    || {
      rm -rf "$testdir"
      fail "failed to create survivor sandbox before gateway upgrade"
    }
  rm -rf "$testdir"

  wait_for_survivor_ready || fail "survivor sandbox did not become Ready before gateway upgrade"
  openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- \
    sh -lc "printf '%s\n' '$SURVIVOR_MARKER' >/tmp/nemoclaw-gateway-upgrade-marker" \
    || fail "failed to write survivor marker before gateway upgrade"

  openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- \
    sh -lc 'rm -f /tmp/nemoclaw-e2e-agent.*; nohup /usr/local/bin/nemoclaw-e2e-agent >/tmp/nemoclaw-e2e-agent.log 2>&1 &' \
    || fail "failed to start survivor agent before gateway upgrade"
  wait_for_survivor_agent_ready || fail "survivor agent did not become healthy before gateway upgrade"
  SURVIVOR_AGENT_PID="$(survivor_agent_pid)"
  SURVIVOR_AGENT_COUNTER_BEFORE="$(survivor_agent_counter)"
  [ -n "$SURVIVOR_AGENT_PID" ] || fail "survivor agent pid was empty before gateway upgrade"

  mkdir -p "$(dirname "$REGISTRY_FILE")"
  python3 - <<PY
import json
from pathlib import Path

path = Path("${REGISTRY_FILE}")
data = {"sandboxes": {}, "defaultSandbox": None}
if path.exists():
    try:
        data = json.loads(path.read_text())
    except Exception:
        pass
data.setdefault("sandboxes", {})["${SURVIVOR_SANDBOX}"] = {
    "name": "${SURVIVOR_SANDBOX}",
    "model": "test-survivor",
    "provider": "test",
    "gpuEnabled": False,
    "policies": [],
    "policyTier": None,
    "agent": None,
    "agentVersion": None,
    "openshellDriver": "docker",
}
data["defaultSandbox"] = data.get("defaultSandbox") or "${SURVIVOR_SANDBOX}"
path.write_text(json.dumps(data, indent=2) + "\n")
PY

  pass "Survivor sandbox and agent pid ${SURVIVOR_AGENT_PID} are Ready before gateway upgrade"
}

assert_survivor_sandbox_after_upgrade() {
  local marker pid counter
  info "Verifying survivor sandbox after OpenShell gateway upgrade"
  wait_for_survivor_ready || fail "survivor sandbox is not Ready after gateway upgrade"

  local marker
  marker="$(
    openshell sandbox exec --name "$SURVIVOR_SANDBOX" -- \
      cat /tmp/nemoclaw-gateway-upgrade-marker 2>/dev/null || true
  )"
  [ "$marker" = "$SURVIVOR_MARKER" ] \
    || fail "survivor marker changed after gateway upgrade: got '${marker}'"

  wait_for_survivor_agent_ready || fail "survivor agent is not healthy after gateway upgrade"
  pid="$(survivor_agent_pid)"
  [ "$pid" = "$SURVIVOR_AGENT_PID" ] \
    || fail "survivor agent process changed across gateway upgrade: was ${SURVIVOR_AGENT_PID}, now ${pid}"
  for _i in $(seq 1 30); do
    counter="$(survivor_agent_counter)"
    if [ "${counter:-0}" -gt "${SURVIVOR_AGENT_COUNTER_BEFORE:-0}" ]; then
      pass "Same survivor agent pid ${pid} is still running after gateway upgrade"
      break
    fi
    sleep 1
  done
  counter="$(survivor_agent_counter)"
  [ "${counter:-0}" -gt "${SURVIVOR_AGENT_COUNTER_BEFORE:-0}" ] \
    || fail "survivor agent heartbeat did not advance after gateway upgrade"

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

  pass "Survivor sandbox remained reachable after OpenShell gateway upgrade"
}

cd "$REPO_ROOT"
load_shell_path

if [ "$(uname -s)" != "Linux" ]; then
  exercise_macos_gateway_installer_regression
  pass "Skipping live Docker-driver gateway restart regression on non-Linux host"
  exit 0
fi

info "Preparing CLI build and OpenShell binaries"
rm -f "$INSTALL_LOG"
if [ ! -d node_modules ]; then
  npm ci --ignore-scripts
fi
npm run build:cli

OLD_OPENSHELL_DIR="$(mktemp -d)"
install_openshell_cli_release_to_dir "$OLD_OPENSHELL_VERSION" "$OLD_OPENSHELL_DIR" "old-install"
export PATH="$OLD_OPENSHELL_DIR:$PATH"

command -v openshell >/dev/null 2>&1 || fail "old openshell not found before upgrade"
if ! openshell --version 2>&1 | grep -q "$OLD_OPENSHELL_VERSION"; then
  fail "test did not start from old OpenShell ${OLD_OPENSHELL_VERSION}"
fi
pass "E2E starts from real OpenShell CLI $(openshell --version)"

CURRENT_OPENSHELL_DIR="$(mktemp -d)"
install_openshell_cli_release_to_dir "$CURRENT_OPENSHELL_VERSION" "$CURRENT_OPENSHELL_DIR" "Docker-driver harness"
install_driver_bins_release_to_dir "$CURRENT_OPENSHELL_VERSION" "$CURRENT_OPENSHELL_DIR" "Docker-driver harness"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
rm -f "$PID_FILE" "$START_LOG" "$GATEWAY_LOG"
openshell gateway remove nemoclaw >/dev/null 2>&1 || true

GATEWAY_BIN="${CURRENT_OPENSHELL_DIR}/openshell-gateway"
SANDBOX_BIN="${CURRENT_OPENSHELL_DIR}/openshell-sandbox"
[ -x "$GATEWAY_BIN" ] || fail "current openshell-gateway harness not found"
[ -x "$SANDBOX_BIN" ] || fail "current openshell-sandbox harness not found"
STALE_GATEWAY_BIN="${STATE_DIR}/openshell-gateway-stale"
cp "$GATEWAY_BIN" "$STALE_GATEWAY_BIN"
chmod 700 "$STALE_GATEWAY_BIN"

info "Starting a stale but healthy Docker-driver gateway"
(
  export OPENSHELL_DRIVERS=docker
  export OPENSHELL_BIND_ADDRESS=127.0.0.1
  export OPENSHELL_SERVER_PORT=8080
  export OPENSHELL_DISABLE_TLS=true
  export OPENSHELL_DISABLE_GATEWAY_AUTH=true
  export OPENSHELL_DB_URL="sqlite:${STATE_DIR}/openshell.db"
  export OPENSHELL_GRPC_ENDPOINT=http://127.0.0.1:8080
  export OPENSHELL_SSH_GATEWAY_HOST=127.0.0.1
  export OPENSHELL_SSH_GATEWAY_PORT=8080
  export OPENSHELL_DOCKER_NETWORK_NAME="${OPENSHELL_DOCKER_NETWORK_NAME:-openshell-docker}"
  export OPENSHELL_DOCKER_SUPERVISOR_IMAGE="$STALE_IMAGE"
  export OPENSHELL_DOCKER_SUPERVISOR_BIN="$SANDBOX_BIN"
  exec "$STALE_GATEWAY_BIN"
) >>"$GATEWAY_LOG" 2>&1 &
OLD_PID="$!"
echo "$OLD_PID" >"$PID_FILE"

for _i in $(seq 1 60); do
  kill -0 "$OLD_PID" 2>/dev/null || fail "stale gateway process exited early"
  openshell gateway add --local --name nemoclaw http://127.0.0.1:8080 >/dev/null 2>&1 || true
  openshell gateway select nemoclaw >/dev/null 2>&1 || true
  if openshell status >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
openshell status >/dev/null 2>&1 || fail "stale gateway never became healthy"

OLD_IMAGE="$(process_env_value "$OLD_PID" OPENSHELL_DOCKER_SUPERVISOR_IMAGE)"
[ "$OLD_IMAGE" = "$STALE_IMAGE" ] || fail "stale gateway did not start with expected image"
pass "Stale gateway is healthy with ${OLD_IMAGE}"
PATH="$CURRENT_OPENSHELL_DIR:$PATH" create_survivor_sandbox

info "Running onboard OpenShell upgrade preflight against old working install"
XDG_BIN_HOME="$OLD_OPENSHELL_DIR" NEMOCLAW_NON_INTERACTIVE=1 \
  node <<'NODE' 2>&1 | tee "$INSTALL_LOG"
const { ensureOpenshellForOnboard } = require("./dist/lib/onboard");

ensureOpenshellForOnboard();
NODE

if ! grep -q "below minimum ${CURRENT_OPENSHELL_VERSION}" "$INSTALL_LOG"; then
  fail "onboard OpenShell preflight did not detect old ${OLD_OPENSHELL_VERSION} install"
fi
if ! grep -q "openshell CLI: openshell ${CURRENT_OPENSHELL_VERSION}" "$INSTALL_LOG"; then
  fail "onboard OpenShell preflight did not select ${CURRENT_OPENSHELL_VERSION} after upgrade"
fi

if ! "$OLD_OPENSHELL_DIR/openshell" --version 2>&1 | grep -q "$CURRENT_OPENSHELL_VERSION"; then
  remove_path_entry "$OLD_OPENSHELL_DIR"
fi
load_shell_path
assert_current_openshell_selected

unset OPENSHELL_DOCKER_SUPERVISOR_IMAGE
unset OPENSHELL_DOCKER_SUPERVISOR_BIN
EXPECTED_IMAGE="$(
  node -e "const { execFileSync } = require('child_process'); const { getDockerDriverGatewayEnv } = require('./dist/lib/onboard'); const version = execFileSync('openshell', ['--version'], { encoding: 'utf8' }).trim(); console.log(getDockerDriverGatewayEnv(version).OPENSHELL_DOCKER_SUPERVISOR_IMAGE);"
)"

info "Invoking NemoClaw gateway start path after install; it must restart the stale process"
unset OPENSHELL_DOCKER_SUPERVISOR_IMAGE
unset OPENSHELL_DOCKER_SUPERVISOR_BIN
node <<'NODE' 2>&1 | tee "$START_LOG"
const { startGateway } = require("./dist/lib/onboard");

startGateway(null)
  .then(() => undefined)
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
NODE

[ -f "$PID_FILE" ] || fail "NemoClaw did not write a replacement gateway pid file"
NEW_PID="$(tr -d '[:space:]' <"$PID_FILE")"
[ -n "$NEW_PID" ] || fail "replacement gateway pid file is empty"
[ "$NEW_PID" != "$OLD_PID" ] || fail "NemoClaw reused the stale gateway pid"

wait "$OLD_PID" 2>/dev/null || true
if kill -0 "$OLD_PID" 2>/dev/null; then
  fail "stale gateway process is still alive after restart"
fi

NEW_IMAGE="$(process_env_value "$NEW_PID" OPENSHELL_DOCKER_SUPERVISOR_IMAGE)"
[ "$NEW_IMAGE" = "$EXPECTED_IMAGE" ] || fail "replacement gateway image was ${NEW_IMAGE:-unset}, expected ${EXPECTED_IMAGE}"

if ! grep -qi "Docker-driver gateway is stale" "$START_LOG"; then
  fail "NemoClaw start log did not report stale gateway restart"
fi

openshell status >/dev/null 2>&1 || fail "replacement gateway is not healthy"
assert_survivor_sandbox_after_upgrade
pass "NemoClaw restarted stale gateway with ${NEW_IMAGE}"

exercise_macos_gateway_installer_regression
