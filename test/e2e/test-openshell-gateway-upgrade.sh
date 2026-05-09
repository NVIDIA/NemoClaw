#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Regression coverage for PR #3001 upgrade installs: if a user already has a
# healthy Linux Docker-driver OpenShell gateway from an older runtime, NemoClaw
# must not reuse it after installing the current OpenShell release. The gateway
# process must be restarted with the supported supervisor image and current
# openshell-sandbox binary before onboarding continues.

set -euo pipefail

LOG_FILE="/tmp/nemoclaw-e2e-openshell-gateway-upgrade.log"
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
  diag "gateway log tail:"
  tail -100 "$GATEWAY_LOG" 2>/dev/null || true
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATE_DIR="${NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR:-$HOME/.local/state/nemoclaw/openshell-docker-gateway}"
PID_FILE="${STATE_DIR}/openshell-gateway.pid"
STALE_IMAGE="ghcr.io/nvidia/openshell/supervisor:0.0.36"
EXPECTED_IMAGE=""

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
  openshell gateway remove nemoclaw >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
}
trap cleanup EXIT

cd "$REPO_ROOT"
load_shell_path

info "Preparing CLI build and OpenShell binaries"
if [ ! -d node_modules ]; then
  npm ci --ignore-scripts
fi
npm run build:cli
bash scripts/install-openshell.sh
load_shell_path

command -v openshell >/dev/null 2>&1 || fail "openshell not found after install"
command -v openshell-gateway >/dev/null 2>&1 || fail "openshell-gateway not found after install"
command -v openshell-sandbox >/dev/null 2>&1 || fail "openshell-sandbox not found after install"
unset OPENSHELL_DOCKER_SUPERVISOR_IMAGE
unset OPENSHELL_DOCKER_SUPERVISOR_BIN
EXPECTED_IMAGE="$(
  node -e "const { execFileSync } = require('child_process'); const { getDockerDriverGatewayEnv } = require('./dist/lib/onboard'); const version = execFileSync('openshell', ['--version'], { encoding: 'utf8' }).trim(); console.log(getDockerDriverGatewayEnv(version).OPENSHELL_DOCKER_SUPERVISOR_IMAGE);"
)"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
rm -f "$PID_FILE" "$START_LOG" "$GATEWAY_LOG"
openshell gateway remove nemoclaw >/dev/null 2>&1 || true

GATEWAY_BIN="$(command -v openshell-gateway)"
SANDBOX_BIN="$(command -v openshell-sandbox)"
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

info "Invoking NemoClaw gateway start path; it must restart the stale process"
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
pass "NemoClaw restarted stale gateway with ${NEW_IMAGE}"
