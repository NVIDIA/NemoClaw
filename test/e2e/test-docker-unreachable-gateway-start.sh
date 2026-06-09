#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Regression E2E for #2347's gateway-start fallback: if `openshell gateway
# start` reports that Docker/Colima is unreachable, onboard must abort before
# gateway health polling and print Docker recovery guidance.

set -euo pipefail

LOG_FILE="/tmp/nemoclaw-e2e-docker-unreachable-gateway-start.log"
START_LOG="/tmp/nemoclaw-e2e-docker-unreachable-gateway-start-node.log"
TRACE_LOG="/tmp/nemoclaw-e2e-docker-unreachable-gateway-start-openshell.log"
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
  diag "node log tail:"
  tail -120 "$START_LOG" 2>/dev/null || true
  diag "fake openshell trace:"
  cat "$TRACE_LOG" 2>/dev/null || true
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN="${TMP_DIR}/bin"
mkdir -p "$FAKE_BIN"
: >"$TRACE_LOG"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$REPO_ROOT"

info "Preparing CLI build"
if [ ! -d node_modules ]; then
  npm ci --ignore-scripts
fi
npm run build:cli

info "Installing fake openshell that reports Docker socket-not-found during gateway start"
cat >"${FAKE_BIN}/openshell" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
TRACE_LOG="${NEMOCLAW_FAKE_OPENSHELL_TRACE:?}"
printf '%s\n' "$*" >>"$TRACE_LOG"

if [[ "$*" == "--version" ]]; then
  printf 'openshell 0.0.44\n'
  exit 0
fi

if [[ "$*" == "gateway --help" ]]; then
  printf 'Commands: start select info destroy remove\n'
  exit 0
fi

if [[ "$*" == *"gateway"*"start"* ]]; then
  printf '%s\n' "__GATEWAY_START__" >>"$TRACE_LOG"
  printf 'Error: Failed to create Docker client.\n'
  printf 'Socket not found: /var/run/docker.sock\n'
  exit 1
fi

# These probes are allowed before gateway start when startGateway() checks
# reusable gateway state. After __GATEWAY_START__, they prove the regression:
# onboard fell through into health/status polling instead of aborting.
if [[ "$*" == "status" || "$*" == *"gateway"*"info"* ]]; then
  printf 'HEALTH POLL REACHED\n'
  exit 0
fi

if [[ "$*" == *"gateway"*"select"* || "$*" == *"gateway"*"destroy"* || "$*" == *"gateway"*"remove"* ]]; then
  exit 0
fi

exit 0
SHIM
chmod 755 "${FAKE_BIN}/openshell"

info "Invoking legacy startGateway() path with macOS/x64 platform semantics"
set +e
PATH="${FAKE_BIN}:$PATH" \
  HOME="${TMP_DIR}/home" \
  NEMOCLAW_FAKE_OPENSHELL_TRACE="$TRACE_LOG" \
  NEMOCLAW_NON_INTERACTIVE="1" \
  NEMOCLAW_HEALTH_POLL_COUNT="5" \
  node <<'NODE' >"$START_LOG" 2>&1
Object.defineProperty(process, "platform", { value: "darwin" });
Object.defineProperty(process, "arch", { value: "x64" });

const { startGateway } = require("./dist/lib/onboard");

startGateway(null)
  .then(() => {
    console.log("__startGateway_returned_successfully__");
    process.exit(0);
  })
  .catch((error) => {
    console.error("__startGateway_threw__");
    console.error(error && error.stack ? error.stack : error);
    process.exit(3);
  });
NODE
NODE_EXIT=$?
set -e

info "node exit code: ${NODE_EXIT}"

if [ "$NODE_EXIT" -ne 1 ]; then
  fail "startGateway should exit 1 when Docker is unreachable, got ${NODE_EXIT}"
fi
pass "startGateway exited 1 on Docker-unreachable gateway-start output"

if ! grep -q "Docker daemon is not running" "$START_LOG"; then
  fail "Docker recovery guidance was not printed"
fi
pass "Docker recovery guidance was printed"

if ! grep -q "colima start" "$START_LOG"; then
  fail "macOS/Colima recovery hint was not printed"
fi
pass "macOS/Colima recovery hint was printed"

if grep -q "Waiting for gateway health" "$START_LOG"; then
  fail "onboard entered gateway health polling after Docker-unreachable gateway-start output"
fi
pass "gateway health polling message was not printed after Docker-unreachable output"

if grep -q "HEALTH POLL REACHED" "$START_LOG"; then
  fail "gateway status/info probe output appeared after Docker-unreachable gateway-start output"
fi
pass "gateway status/info probe output did not appear in user output"

POST_START_PROBES="$(awk '
  /__GATEWAY_START__/ { seen = 1; next }
  seen && ($0 == "status" || $0 ~ /gateway.*info/) { print }
' "$TRACE_LOG")"
if [ -n "$POST_START_PROBES" ]; then
  fail "status/gateway-info probes ran after Docker-unreachable gateway start: ${POST_START_PROBES}"
fi
pass "no status/gateway-info probes ran after Docker-unreachable gateway start"

if grep -q "openshell doctor logs" "$START_LOG"; then
  fail "generic OpenShell diagnostics were printed instead of Docker-specific recovery guidance"
fi
pass "generic OpenShell diagnostics were skipped for Docker-unreachable gateway start"

echo ""
pass "#2347 gateway-start fallback E2E green"
