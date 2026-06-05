#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Coverage guard for issue #3111 — "Docker-driver gateway is healthy"
# must not be logged when the gateway binary failed to start.
#
# Background: PR #3001 introduced a Linux Docker-driver gateway managed by
# onboard.ts:startGateway(). On Ubuntu 22.04, the shipped openshell-gateway
# binary is linked against GLIBC 2.38/2.39 and crashes immediately on a
# 22.04 host (GLIBC 2.35). NemoClaw still reports "✓ Docker-driver gateway
# is healthy" because:
#   - the detached child becomes a zombie, so isPidAlive(childPid) returns
#     true (the pid remains in the process table until the parent reaps it);
#   - registerDockerDriverGatewayEndpoint() is metadata-only (openshell
#     gateway add --local) and succeeds without any TCP probe;
#   - isGatewayHealthy() reads openshell status / gateway info strings,
#     not a live health probe — so cached / metadata-only output satisfies
#     the check.
#
# This test is platform-independent: instead of exercising the GLIBC path
# (which requires a 22.04 runner we don't have in CI) it substitutes the
# gateway binary with a shim that crashes immediately with the same
# GLIBC-style error on stderr. Any onboard that treats a crashed child as
# healthy fails this test. The fix for #3111 must make startGateway verify
# the child is actually alive (not a zombie) and that the endpoint serves
# a real TCP probe before declaring "healthy".
#
# Expected result on main (bug present): FAIL — the test asserts onboard
# must NOT print "Docker-driver gateway is healthy" when the binary
# crashed; current code does print it, so the assertion fails.
# Expected result after fix: PASS — onboard surfaces the crash and exits
# non-zero.
#
# Related: #3111, PR #3001

set -euo pipefail

LOG_FILE="/tmp/nemoclaw-e2e-gateway-health-honest.log"
START_LOG="/tmp/nemoclaw-e2e-gateway-health-honest-start.log"
GATEWAY_LOG="/tmp/nemoclaw-e2e-gateway-health-honest-process.log"
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
  diag "start log tail:"
  tail -80 "$START_LOG" 2>/dev/null || true
  diag "gateway process log tail:"
  tail -80 "$GATEWAY_LOG" 2>/dev/null || true
  diag "onboard gateway log tail (where sabotage stderr lands):"
  tail -80 "${STATE_DIR}/openshell-gateway.log" 2>/dev/null || true
  diag "openshell status: $(openshell status 2>&1 || true)"
  diag "gateway info: $(openshell gateway info -g nemoclaw 2>&1 || true)"
  diag "pid file: $(cat "${PID_FILE:-/dev/null}" 2>/dev/null || echo missing)"
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATE_DIR="${NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR:-$HOME/.local/state/nemoclaw/openshell-docker-gateway}"
PID_FILE="${STATE_DIR}/openshell-gateway.pid"
SABOTAGE_BIN="${STATE_DIR}/openshell-gateway-sabotage"
CHILD_PID=""

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

cleanup_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  # Reap any zombies left over by the test
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  set +e
  if [ -f "$PID_FILE" ]; then
    CHILD_PID="$(tr -d '[:space:]' <"$PID_FILE")"
  fi
  cleanup_pid "$CHILD_PID"
  openshell gateway remove nemoclaw >/dev/null 2>&1 || true
  rm -f "$PID_FILE" "$SABOTAGE_BIN"
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

# Start from a clean slate: no prior gateway metadata, no pid file.
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
rm -f "$PID_FILE" "$START_LOG" "$GATEWAY_LOG"
openshell gateway remove nemoclaw >/dev/null 2>&1 || true

info "Installing sabotage gateway binary that simulates the #3111 GLIBC crash"
cat >"$SABOTAGE_BIN" <<'SHIM'
#!/usr/bin/env bash
# Simulates the Ubuntu 22.04 GLIBC-2.38/2.39 failure mode reported in #3111.
# The real binary dies at the dynamic-linker stage before main() runs; we
# mirror that by emitting the same stderr fragment and exiting non-zero
# before opening any TCP port.
printf '%s\n' "$(basename "$0"): /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.38' not found (required by $(basename "$0"))" >&2
printf '%s\n' "$(basename "$0"): /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.39' not found (required by $(basename "$0"))" >&2
exit 127
SHIM
chmod 755 "$SABOTAGE_BIN"

info "Invoking startGateway() with the sabotaged binary"
# startGateway() with exitOnFailure:true calls process.exit(1) when it
# concludes the gateway failed. A correctly-behaved onboard MUST either:
#   (a) exit non-zero, OR
#   (b) print "failed to start" / a surface error message,
# and MUST NOT print "Docker-driver gateway is healthy".
set +e
NEMOCLAW_OPENSHELL_GATEWAY_BIN="$SABOTAGE_BIN" \
  NEMOCLAW_HEALTH_POLL_COUNT="${NEMOCLAW_HEALTH_POLL_COUNT:-10}" \
  NEMOCLAW_HEALTH_POLL_INTERVAL="${NEMOCLAW_HEALTH_POLL_INTERVAL:-1}" \
  node <<'NODE' 2>&1 | tee "$START_LOG"
const { startGateway } = require("./dist/lib/onboard");

startGateway(null)
  .then(() => {
    console.log("__onboard_startGateway_returned_successfully__");
    process.exit(0);
  })
  .catch((error) => {
    console.error("__onboard_startGateway_threw__");
    console.error(error && error.stack ? error.stack : error);
    process.exit(3);
  });
NODE
NODE_EXIT=$?
set -e

info "node exit code: ${NODE_EXIT}"

# ── Pre-assertion: prove the sabotage path was actually exercised ───
# Without this guard, an unrelated setup failure (module-not-found,
# missing env, stale dist/, etc.) could produce a $START_LOG that
# happens to lack the 'healthy' string and thereby false-green the
# primary assertion. We require positive evidence that the sabotage
# shim ran.
#
# The sabotage shim writes its GLIBC-style stderr to the gateway log
# file opened by onboard.ts:startGatewayWithOptions at
# $STATE_DIR/openshell-gateway.log (NOT to the start log, which only
# captures node's stdout/stderr). That gateway log is the authoritative
# source of truth for "did our binary get exec'd".
GATEWAY_ONBOARD_LOG="${STATE_DIR}/openshell-gateway.log"
if ! grep -qE 'GLIBC_2\.3(8|9)|openshell-gateway-sabotage' "$GATEWAY_ONBOARD_LOG" 2>/dev/null; then
  fail "Sabotage markers (GLIBC_2.38/2.39 or 'openshell-gateway-sabotage') not observed in gateway log ${GATEWAY_ONBOARD_LOG} — the test may have failed before the sabotaged gateway was invoked, so the assertions below cannot be trusted. Inspect $START_LOG and $GATEWAY_ONBOARD_LOG above for the real cause."
fi
pass "Sabotage shim was invoked as expected (GLIBC/sabotage markers present in gateway log)"

# ── Primary assertion ────────────────────────────────────────────────
# This is the bug from #3111. Onboard printed "healthy" while the child
# process was a crashed zombie and had never served a real connection.
if grep -q "✓ Docker-driver gateway is healthy" "$START_LOG" \
  || grep -q "Docker-driver gateway is healthy" "$START_LOG"; then
  fail "Onboard reported '✓ Docker-driver gateway is healthy' although the gateway binary crashed on startup (#3111 false-positive health check)"
fi
pass "Onboard did not falsely log 'Docker-driver gateway is healthy' when the binary crashed"

# ── Corroborating assertion 1: non-zero exit ─────────────────────────
# startGateway(null) uses exitOnFailure:true → the node process MUST exit
# non-zero when the gateway truly failed to start. Exit 0 means onboard
# silently accepted the crashed gateway as success.
if [ "$NODE_EXIT" -eq 0 ] || grep -q "__onboard_startGateway_returned_successfully__" "$START_LOG"; then
  fail "startGateway() resolved successfully despite a crashed binary — onboard would have proceeded to inference setup against a dead gateway"
fi
pass "startGateway() did not resolve successfully with a crashed binary (node exit=${NODE_EXIT})"

# ── Corroborating assertion 2: user-visible failure surfaced ─────────
# Deliberately narrow: excludes generic 'not found' because an unrelated
# module-not-found (e.g. stale dist/) would satisfy the match without
# proving the gateway-failure code path was exercised. The Pre-assertion
# above already proves the sabotage ran, but this stays narrow anyway.
if ! grep -qiE "failed to start|gateway.*(crash|exit|error)|__onboard_startGateway_threw__" "$START_LOG"; then
  fail "Onboard did not surface any gateway failure indicator to the user"
fi
pass "Onboard surfaced a user-visible gateway failure message"

# ── Corroborating assertion 3: no live gateway process ───────────────
if [ -f "$PID_FILE" ]; then
  LINGERING_PID="$(tr -d '[:space:]' <"$PID_FILE")"
  if [ -n "$LINGERING_PID" ] && kill -0 "$LINGERING_PID" 2>/dev/null; then
    # A live pid that is *not* a zombie would mean onboard somehow kept
    # something alive. Zombies are acceptable as a transient artifact.
    STATE="$(ps -p "$LINGERING_PID" -o state= 2>/dev/null | tr -d ' ')"
    if [ "$STATE" != "Z" ] && [ -n "$STATE" ]; then
      fail "A non-zombie gateway pid (${LINGERING_PID}, state=${STATE}) is still alive after a simulated crash"
    fi
  fi
fi
pass "No live (non-zombie) gateway process is running after the simulated crash"

echo ""
pass "#3111 coverage guard green: onboard correctly surfaces a crashed gateway"
