#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Jetson nvmap GPU status E2E: reproduces the EXACT reporter workflow from
# issue #4231 on a Jetson Orin host and proves the fix.
#
# Reporter symptom (NemoClaw v0.0.58, Jetson Orin, reopened after PR #4599):
#   - sandbox user groups: uid=998(sandbox) gid=998(sandbox) groups=998(sandbox)
#   - /dev/nvmap is `crw-rw---- root video`
#   - CUDA fails inside the sandbox with `NvRmMemInitNvmap failed with
#     Permission denied`, cuInit(0)=999
#   - `nemoclaw status` still reports "Sandbox GPU: enabled" (misleading)
#
# Root cause: the Jetson Docker GPU recreate did not grant the sandbox user
# membership in the host group (`video`) that owns the Tegra device nodes, so
# CUDA could not open /dev/nvmap even though the devices were mounted.
#
# This test runs the reporter's exact workflow end-to-end:
#   1. Onboard with GPU passthrough (Jetson auto-enables sandbox GPU)
#   2. Inspect the sandbox user's supplementary groups (`id`)
#   3. Inspect /dev/nvmap inside the sandbox (`ls -l`)
#   4. Run the authoritative CUDA usability proof (cuInit(0)) inside the sandbox
#   5. Assert `nemoclaw status` reports "(CUDA verified)" — not a bare/misleading
#      "enabled", "(CUDA unverified)", or "(last CUDA proof failed)"
#
# Acceptance gate (#4231): the test passes only when CUDA actually initializes
# in the sandbox (cuInit(0)=0) AND status reflects proven CUDA usability. A
# bare "enabled" is treated as a failure.
#
# Prerequisites:
#   - NVIDIA Jetson Orin (or other L4T/Tegra) host with /dev/nvmap present
#   - NVIDIA Container Runtime configured for Docker (nvidia-ctk runtime configure)
#   - Docker
#   - NEMOCLAW_NON_INTERACTIVE=1
#   - NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#   - A working inference provider (default: ollama; onboard handles startup)
#
# On a non-Jetson host this test SKIPS cleanly (exit 0) so it is safe to wire
# into pipelines that may schedule it on mixed hardware.
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     bash test/e2e/test-jetson-nvmap-gpu.sh

# ShellCheck cannot see EXIT trap invocations of cleanup helpers in this E2E script.
# shellcheck disable=SC2317
set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# Determine repo root
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-jetson-nvmap}"
TEST_LOG="/tmp/nemoclaw-jetson-nvmap-e2e-test.log"
INSTALL_LOG="/tmp/nemoclaw-jetson-nvmap-e2e-install.log"
export NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-ollama}"

exec > >(tee -a "$TEST_LOG") 2>&1

# ══════════════════════════════════════════════════════════════════
# Phase 0: Jetson hardware gate
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Jetson hardware gate"

is_jetson() {
  [ -e /dev/nvmap ] && return 0
  [ -f /etc/nv_tegra_release ] && return 0
  if [ -r /proc/device-tree/model ] && grep -qi "jetson\|orin\|tegra" /proc/device-tree/model 2>/dev/null; then
    return 0
  fi
  return 1
}

if ! is_jetson; then
  skip "Not a Jetson/Tegra host (/dev/nvmap absent) — reporter workflow requires Jetson hardware"
  echo ""
  echo "  This test reproduces issue #4231 on Jetson Orin. It cannot run on"
  echo "  non-Jetson hardware. Hermetic regression coverage of the same fix"
  echo "  (sandbox user → /dev/nvmap group propagation) lives in"
  echo "  src/lib/onboard/docker-gpu-patch.test.ts."
  echo ""
  echo "  Skipped (exit 0): no Jetson hardware available."
  exit 0
fi
pass "Jetson/Tegra host detected (/dev/nvmap present)"

HOST_NVMAP_PERMS="$(ls -l /dev/nvmap 2>/dev/null || true)"
HOST_NVMAP_GID="$(stat -c '%g' /dev/nvmap 2>/dev/null || true)"
HOST_NVMAP_GROUP="$(stat -c '%G' /dev/nvmap 2>/dev/null || true)"
info "Host /dev/nvmap: ${HOST_NVMAP_PERMS}"
info "Host /dev/nvmap owning group: ${HOST_NVMAP_GROUP} (gid ${HOST_NVMAP_GID})"

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi
if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required for non-interactive onboard"
  exit 1
fi

# Best-effort cleanup on any exit (prevents dirty state on reused runners)
# shellcheck disable=SC2329 # invoked via trap
cleanup() {
  info "Running exit cleanup..."
  if command -v nemoclaw >/dev/null 2>&1; then
    nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  fi
  if command -v openshell >/dev/null 2>&1; then
    openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
    openshell gateway destroy -g nemoclaw 2>/dev/null || true
  fi
  pkill -f "ollama serve" 2>/dev/null || true
  pkill -f "ollama-auth-proxy" 2>/dev/null || true
}
trap cleanup EXIT

# ══════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

# Jetson sandbox GPU uses the NVIDIA Container Runtime (not CDI).
if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"\|nvidia:'; then
  pass "Docker NVIDIA runtime detected"
else
  fail "Docker NVIDIA runtime not detected — run: sudo nvidia-ctk runtime configure --runtime=docker"
  exit 1
fi

# Pre-cleanup
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi

# Install Ollama binary if the provider needs it (onboard starts it).
if [ "$NEMOCLAW_PROVIDER" = "ollama" ] && ! command -v ollama >/dev/null 2>&1; then
  info "Installing Ollama binary..."
  curl -fsSL https://ollama.com/install.sh | sh 2>&1 || true
  systemctl stop ollama 2>/dev/null || true
  pkill -f "ollama serve" 2>/dev/null || true
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Onboard with GPU (reporter workflow)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Onboard with GPU passthrough"

cd "$REPO" || {
  fail "Could not cd to repo root: $REPO"
  exit 1
}

info "Running install.sh --non-interactive (Jetson auto-enables sandbox GPU)..."
bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

# Pick up PATH changes from the installer.
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ $install_exit -eq 0 ]; then
  pass "install.sh completed (exit 0)"
else
  fail "install.sh failed (exit $install_exit)"
  tail -40 "$INSTALL_LOG"
  exit 1
fi

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

# 2a: The Jetson recreate must announce that it grants the Tegra device-node
# group(s) to the sandbox user (the fix for #4231).
if grep -Fq "Granting sandbox user access to Jetson Tegra GPU device nodes via --group-add" "$INSTALL_LOG"; then
  GROUP_ADD_LINE="$(grep -F "Granting sandbox user access to Jetson Tegra GPU device nodes" "$INSTALL_LOG" | head -1)"
  pass "Onboard granted Tegra device-node group via --group-add"
  info "${GROUP_ADD_LINE}"
else
  fail "Onboard did not grant the Tegra device-node group (--group-add) — #4231 fix missing"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: In-sandbox device + group + CUDA inspection (reporter workflow)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: In-sandbox /dev/nvmap, groups, and CUDA proof"

# 3a: sandbox user supplementary groups — must now include the /dev/nvmap GID.
SANDBOX_ID="$(openshell sandbox exec -n "$SANDBOX_NAME" -- sh -lc 'id' 2>&1)" || true
info "sandbox 'id': ${SANDBOX_ID}"
if [ -n "$HOST_NVMAP_GID" ] && echo "$SANDBOX_ID" | grep -Eq "(^|[(,=])${HOST_NVMAP_GID}([(,) ]|$)"; then
  pass "Sandbox user is a member of the /dev/nvmap owning group (gid ${HOST_NVMAP_GID})"
else
  fail "Sandbox user is NOT in the /dev/nvmap owning group (gid ${HOST_NVMAP_GID}) — CUDA will be denied"
fi

# 3b: /dev/nvmap present inside the sandbox.
SANDBOX_NVMAP="$(openshell sandbox exec -n "$SANDBOX_NAME" -- sh -lc 'ls -l /dev/nvmap' 2>&1)" || true
info "sandbox /dev/nvmap: ${SANDBOX_NVMAP}"
if echo "$SANDBOX_NVMAP" | grep -q "/dev/nvmap"; then
  pass "/dev/nvmap is present inside the sandbox"
else
  fail "/dev/nvmap is not present inside the sandbox"
fi

# 3c: Authoritative CUDA usability proof — cuInit(0) must return 0. This is the
# exact signal the reporter saw fail (cuInit=999, NvRmMemInitNvmap denied).
CUDA_PROBE='python3 -c '\''import ctypes; lib = ctypes.CDLL("libcuda.so.1"); rc = lib.cuInit(0); print(f"cuInit(0)={rc}"); raise SystemExit(0 if rc == 0 else 1)'\'''
CUDA_OUT="$(openshell sandbox exec -n "$SANDBOX_NAME" -- sh -lc "$CUDA_PROBE" 2>&1)" || true
info "sandbox cuInit probe: ${CUDA_OUT}"
if echo "$CUDA_OUT" | grep -q "cuInit(0)=0"; then
  pass "CUDA initialized inside the sandbox (cuInit(0)=0)"
elif echo "$CUDA_OUT" | grep -qi "NvRmMemInitNvmap\|Permission denied"; then
  fail "CUDA failed with the reporter's nvmap permission error: ${CUDA_OUT}"
else
  fail "CUDA did not initialize inside the sandbox: ${CUDA_OUT}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: nemoclaw status must report proven CUDA usability
# ══════════════════════════════════════════════════════════════════
section "Phase 4: nemoclaw status CUDA proof state"

STATUS_OUT="$(nemoclaw "$SANDBOX_NAME" status 2>&1)" || true
echo "$STATUS_OUT" | grep -F "Sandbox GPU:" || true

if echo "$STATUS_OUT" | grep -Fq "Sandbox GPU: enabled"; then
  pass "Status reports Sandbox GPU: enabled (Jetson auto-enable)"
else
  fail "Status does not report Sandbox GPU enabled"
fi

# The core #4231 assertion: status must carry "(CUDA verified)" — a bare
# "enabled", "(CUDA unverified)", or "(last CUDA proof failed)" is the
# misleading state the reporter hit and must NOT pass.
if echo "$STATUS_OUT" | grep -Fq "CUDA verified"; then
  pass "Status reports (CUDA verified) — GPU usability is proven, not misleading"
elif echo "$STATUS_OUT" | grep -Eq "last CUDA proof failed"; then
  fail "Status shows CUDA proof FAILED — Jetson nvmap access not granted (#4231 unfixed)"
elif echo "$STATUS_OUT" | grep -Fq "CUDA unverified"; then
  fail "Status shows CUDA UNVERIFIED — proof did not confirm usability (#4231 misleading state)"
else
  fail "Status reports a bare 'enabled' with no CUDA proof state (#4231 misleading status)"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Jetson nvmap GPU E2E Results (#4231):"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"
echo ""

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Jetson nvmap GPU E2E PASSED — CUDA usable + status proven (#4231).\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
