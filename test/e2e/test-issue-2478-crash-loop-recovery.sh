#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Long-running e2e regression for NVIDIA/NemoClaw#2478 — gateway crash-loop
# recovery when a sandboxed library throws on init.
#
#   STAYS_IN_PR_UNTIL_SHIP — delete this file before merging the fix once
#   the soak has produced a clean run on a real DGX Spark / Brev instance.
#   Tracking removal in the PR description, not here, so the file does not
#   silently outlive the issue it was written for.
#
# What this test exercises (the fix from #2478):
#
#   The sandbox ships a chain of NODE_OPTIONS=--require preloads (sandbox
#   safety-net, ciao networkInterfaces guard, slack guard, http-proxy fix,
#   ws-proxy fix, nemotron fix). They are emitted into
#   /tmp/nemoclaw-proxy-env.sh at sandbox-start and reach the gateway via
#   ~/.bashrc on the FIRST start. Before #2478 the gateway recovery path
#   (laptop sleep, health-monitor restart, manual `nemoclaw <name> connect`)
#   silently swallowed sourcing errors with `2>/dev/null` and never asserted
#   that NODE_OPTIONS actually contained the guards. A stale or missing
#   proxy-env.sh therefore left the respawned gateway naked, and any library
#   that threw during init (ciao mDNS being the trigger documented in the
#   issue) crashed the gateway in a loop forever.
#
# This test:
#
#   1. Onboards a sandbox normally.
#   2. Verifies the *initial* gateway has the safety-net + ciao guard active
#      (via /proc/<pid>/environ on the gateway PID).
#   3. Crash-recovery loop (NORMAL): kill the gateway 5x, each time triggers
#      `nemoclaw <name> connect` (which calls recoverSandboxProcesses), and
#      checks the respawned gateway still has guards in NODE_OPTIONS.
#   4. Negative case: removes /tmp/nemoclaw-proxy-env.sh, kills the gateway,
#      triggers recovery — expects the new "[gateway-recovery] WARNING"
#      line in stderr (visible via gateway.log) instead of silent guard loss.
#   5. Soak: leaves the sandbox idle for $NEMOCLAW_E2E_SOAK_SECONDS
#      (default 300) so the health-monitor restart cadence (~4 min in prod)
#      gets at least one chance to fire, then asserts the gateway has not
#      crash-looped in the meantime (PID stable OR exactly one clean
#      respawn, no churn).
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required for onboard
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-2478)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS           — overall timeout (default: 1500)
#   NEMOCLAW_E2E_CRASH_CYCLES              — crash-recover cycles (default: 5)
#   NEMOCLAW_E2E_SOAK_SECONDS              — idle soak window (default: 300)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 \
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#   NVIDIA_API_KEY=nvapi-... \
#     bash test/e2e/test-issue-2478-crash-loop-recovery.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1500
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

PASS=0
FAIL=0
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
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-2478}"
CRASH_CYCLES="${NEMOCLAW_E2E_CRASH_CYCLES:-5}"
SOAK_SECONDS="${NEMOCLAW_E2E_SOAK_SECONDS:-300}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"

# ── Helpers ──────────────────────────────────────────────────────

# Run a command inside the sandbox via openshell sandbox exec. Returns
# stdout; non-zero exit prints stderr but does not abort the test.
sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- "$@" 2>&1
}

# Get the current openclaw gateway PID inside the sandbox, or empty string.
# The gateway re-execs to argv `openclaw-gateway` after startup (it spawns
# from the launcher whose argv is `openclaw gateway run`). Match either form
# via `[o]penclaw[ -]gateway` — bracket trick prevents pgrep self-match,
# `[ -]` accepts both the launcher (space) and the post-rename (dash). `-o`
# returns the OLDEST match (the long-lived launcher 262 in the typical
# parent/child tree); env is inherited so NODE_OPTIONS reads the same.
gateway_pid() {
  sandbox_exec sh -c "pgrep -fo '[o]penclaw[ -]gateway'" | tr -d '[:space:]'
}

# Read /tmp/nemoclaw-proxy-env.sh — the single source of truth for the
# NODE_OPTIONS guard chain that the recovery script sources before
# launching the gateway. Owned root:root 444, readable by sandbox user.
proxy_env_contents() {
  sandbox_exec sh -c "cat /tmp/nemoclaw-proxy-env.sh 2>/dev/null"
}

# Returns 0 if the gateway has the library guard chain active, 1 otherwise.
# /proc/<pid>/environ is unreadable across non-ancestor process trees due
# to kernel.yama.ptrace_scope=1, so we verify the guards by their effects:
#   1. proxy-env.sh contains the safety-net + ciao preload exports (the
#      recovery script will pick these up on the next respawn).
#   2. gateway.log contains deterministic gateway-process preload markers
#      from the safety-net and ciao guards. Older builds also emitted
#      `[guard] os.networkInterfaces() failed:` when ciao happened to touch
#      os.networkInterfaces(), but that library call is not a stable
#      post-respawn oracle.
#   3. The gateway PID is alive after the guard activations (proves the
#      guard prevented a crash, which is the whole point).
# Waits up to $2 seconds (default 30) for log signatures to accrue.
gateway_guards_active() {
  local pid="$1"
  local timeout="${2:-30}"
  local elapsed=0

  if [ -z "$pid" ]; then
    return 1
  fi

  local env_contents
  env_contents="$(proxy_env_contents)"
  if ! echo "$env_contents" | grep -q 'nemoclaw-sandbox-safety-net'; then
    echo "  [guards] proxy-env.sh missing safety-net export"
    return 1
  fi
  if ! echo "$env_contents" | grep -q 'nemoclaw-ciao-network-guard'; then
    echo "  [guards] proxy-env.sh missing ciao-network-guard export"
    return 1
  fi

  while [ "$elapsed" -lt "$timeout" ]; do
    if sandbox_exec sh -c "grep -Eq '\\[sandbox-safety-net\\] loaded \\((openclaw-gateway|launcher)\\)' /tmp/gateway.log 2>/dev/null" \
      && sandbox_exec sh -c "grep -Eq '\\[guard\\] ciao-network-guard loaded \\((openclaw-gateway|launcher)\\)' /tmp/gateway.log 2>/dev/null"; then
      # Confirm gateway is still alive after guard activations.
      if [ -n "$(gateway_pid)" ]; then
        return 0
      fi
      echo "  [guards] guard fired but gateway no longer running"
      return 1
    fi
    # Backward-compatible proof for older images: this line is emitted by
    # the ciao preload only when ciao calls os.networkInterfaces().
    if sandbox_exec sh -c "grep -Fq '[guard] os.networkInterfaces() failed:' /tmp/gateway.log 2>/dev/null"; then
      if [ -n "$(gateway_pid)" ]; then
        return 0
      fi
      echo "  [guards] guard fired but gateway no longer running"
      return 1
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done

  echo "  [guards] no gateway-process guard activation signatures in gateway.log within ${timeout}s"
  return 1
}

# Tail gateway.log from inside the sandbox (last N lines).
gateway_log_tail() {
  sandbox_exec sh -c "tail -n ${1:-50} /tmp/gateway.log 2>/dev/null"
}

# Verify the gateway is actually serving its inference API, not just alive
# as a process. A NemoClaw user reported on #2478 that pre-fix the ciao
# crash left `https://inference.local/v1/models` returning empty — i.e.
# their deployed model "disappeared" from the user's perspective. This
# helper closes that loop so we prove the recovery preserves the
# user-visible service surface, not just the OS process. Polls up to $1
# seconds (default 30) since the new gateway needs ~1-3s to bind after
# launch.
gateway_serves_inference() {
  local timeout="${1:-30}"
  local elapsed=0
  local out=""
  while [ "$elapsed" -lt "$timeout" ]; do
    out="$(sandbox_exec sh -c 'curl -sf --max-time 5 https://inference.local/v1/models 2>/dev/null')"
    # OpenAI-compatible /v1/models response — top-level "data" array, plus
    # entries with "object" or "id". Match any of the three to be tolerant
    # of provider-specific shapes (NVIDIA Endpoints vs. local Ollama).
    case "$out" in
      *'"data"'* | *'"object"'* | *'"id"'*) return 0 ;;
    esac
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "  [inference] /v1/models did not return a usable response within ${timeout}s"
  echo "  [inference] last response: ${out:0:200}"
  return 1
}

# Dump diagnostic snapshot for triage when an environ read or guard
# assertion fails. Helps distinguish wrong-PID matching, gateway-not-running,
# and cross-namespace /proc visibility issues.
gateway_diagnostics() {
  local pid="${1:-}"
  echo "  --- gateway diagnostics ---"
  echo "  [exec context: whoami / hostname / pwd / pid namespace]"
  # shellcheck disable=SC2016  # intentional: expand inside sandbox, not host
  sandbox_exec sh -c 'echo "user=$(whoami) host=$(hostname) pwd=$(pwd) pid_ns=$(readlink /proc/self/ns/pid 2>/dev/null)"' | sed 's/^/    /'
  echo "  [pgrep -af '[o]penclaw' (any openclaw process)]"
  sandbox_exec sh -c "pgrep -af '[o]penclaw' || echo '(no matches)'" | sed 's/^/    /'
  echo "  [ps auxf (full tree, top 40 lines)]"
  sandbox_exec sh -c "ps auxf 2>/dev/null | head -40 || ps -ef 2>/dev/null | head -40" | sed 's/^/    /'
  echo "  [ls /tmp (gateway.log presence + size)]"
  sandbox_exec sh -c "ls -la /tmp/gateway.log /tmp/auto-pair.log /tmp/openclaw-* 2>&1 | head -20" | sed 's/^/    /'
  echo "  [tail /tmp/gateway.log -n 60]"
  sandbox_exec sh -c "tail -n 60 /tmp/gateway.log 2>&1 || echo '(no gateway.log)'" | sed 's/^/    /'
  echo "  [nemoclaw status]"
  nemoclaw "$SANDBOX_NAME" status 2>&1 | head -30 | sed 's/^/    /'
  echo "  [openshell sandbox containers / pod]"
  openshell sandbox info --name "$SANDBOX_NAME" 2>&1 | head -20 | sed 's/^/    /' || true
  if [ -n "$pid" ]; then
    echo "  [reported pid: $pid]"
    echo "  [/proc/${pid} listing]"
    sandbox_exec sh -c "ls -la /proc/${pid}/ 2>&1 | head -8 || echo '(cannot list)'" | sed 's/^/    /'
    echo "  [/proc/${pid}/cmdline]"
    sandbox_exec sh -c "cat /proc/${pid}/cmdline 2>&1 | tr '\\0' ' '; echo" | sed 's/^/    /'
    echo "  [/proc/${pid}/status (uid/state)]"
    sandbox_exec sh -c "grep -E '^(Name|State|Uid|Pid|PPid):' /proc/${pid}/status 2>&1" | sed 's/^/    /'
  fi
  echo "  ---------------------------"
}

# Wait until gateway PID is non-empty (or timeout). Echoes pid, returns 0/1.
wait_for_gateway_up() {
  local timeout="${1:-30}"
  local elapsed=0 pid=""
  while [ "$elapsed" -lt "$timeout" ]; do
    pid="$(gateway_pid)"
    if [ -n "$pid" ]; then
      echo "$pid"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo ""
  return 1
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Preflight
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Preflight"

if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  exit 1
fi
pass "Docker running"

if [ -z "${NVIDIA_API_KEY:-}" ] || [[ "${NVIDIA_API_KEY}" != nvapi-* ]]; then
  fail "NVIDIA_API_KEY not set or invalid"
  exit 1
fi
pass "NVIDIA_API_KEY set"

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ] || [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 and NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 are required"
  exit 1
fi
pass "Required env vars set"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Pre-cleanup + onboard
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Pre-cleanup + onboard"

if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
fi

cd "$REPO_ROOT" || {
  fail "cd $REPO_ROOT"
  exit 1
}

INSTALL_LOG="$(mktemp)"
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1

install_exit=$?
if [ $install_exit -ne 0 ]; then
  fail "install.sh failed (exit $install_exit). Last 30 lines:"
  tail -30 "$INSTALL_LOG"
  rm -f "$INSTALL_LOG"
  exit 1
fi
rm -f "$INSTALL_LOG"
pass "install.sh + onboard completed"

# Pick up PATH changes
[ -f "$HOME/.bashrc" ] && { source "$HOME/.bashrc" 2>/dev/null || true; }
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw not on PATH after install"
  exit 1
fi
pass "nemoclaw on PATH"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Verify initial gateway has the guard chain
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Initial gateway has guard chain"

INIT_PID="$(wait_for_gateway_up 60)"
if [ -z "$INIT_PID" ]; then
  fail "Gateway never came up after onboard"
  gateway_diagnostics ""
  exit 1
fi
pass "Gateway up (pid=$INIT_PID)"

if gateway_guards_active "$INIT_PID" 30; then
  pass "Initial gateway has guard chain active (proxy-env exports + gateway preloads loaded)"
else
  fail "Initial gateway missing library guard chain — fix is not deployed?"
  gateway_diagnostics "$INIT_PID"
  exit 1
fi

if gateway_serves_inference 30; then
  pass "Initial gateway serves inference API (https://inference.local/v1/models responds)"
else
  fail "Initial gateway alive but not serving inference — recovery is incomplete from user POV"
  gateway_diagnostics "$INIT_PID"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Crash-recovery loop ($CRASH_CYCLES cycles)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Crash-recovery loop ($CRASH_CYCLES cycles)"

prev_pid="$INIT_PID"
for cycle in $(seq 1 "$CRASH_CYCLES"); do
  info "Cycle $cycle/$CRASH_CYCLES — killing gateway pid=$prev_pid"
  sandbox_exec sh -c "kill -9 $prev_pid 2>/dev/null; sleep 1; pgrep -fo '[o]penclaw[ -]gateway' || echo DEAD" >/dev/null

  # Trigger recovery via the actual code path: `nemoclaw <name> status`
  # calls checkAndRecoverSandboxProcesses() → recoverSandboxProcesses(),
  # which is the hardened path #2478 changes. Bound it with `timeout`
  # so a hang in CLI internals cannot eat the whole 30-min job budget.
  timeout 60 nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1 || true

  new_pid="$(wait_for_gateway_up 45)"
  if [ -z "$new_pid" ]; then
    fail "Cycle $cycle: gateway did not respawn within 45s"
    gateway_log_tail 60
    exit 1
  fi
  if [ "$new_pid" = "$prev_pid" ]; then
    fail "Cycle $cycle: PID unchanged ($new_pid) — kill did not land"
    exit 1
  fi
  pass "Cycle $cycle: gateway respawned (pid $prev_pid → $new_pid)"

  if gateway_guards_active "$new_pid" 30; then
    pass "Cycle $cycle: respawned gateway retains guard chain (proxy-env + gateway preloads loaded)"
  else
    fail "Cycle $cycle: respawned gateway LOST guard chain — recovery hardening regressed"
    gateway_diagnostics "$new_pid"
    gateway_log_tail 80
    exit 1
  fi

  if gateway_serves_inference 30; then
    pass "Cycle $cycle: respawned gateway serves inference API"
  else
    fail "Cycle $cycle: gateway up + guards active but inference API not serving"
    gateway_diagnostics "$new_pid"
    gateway_log_tail 80
    exit 1
  fi

  prev_pid="$new_pid"
done

# ══════════════════════════════════════════════════════════════════
# Phase 4: Negative case — env file missing → warning logged
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Negative case — proxy-env.sh missing surfaces a warning"

# Snapshot proxy-env.sh contents so we can restore after the test.
# Capture as base64 from inside the sandbox so the round-trip is byte-
# faithful — `$(cat ...)` would strip trailing newlines and break the
# eventual size verification by ~2 bytes. We also pull the original size
# separately so the post-restore wc -c can be compared exactly.
SNAPSHOT_B64="$(sandbox_exec sh -c 'base64 < /tmp/nemoclaw-proxy-env.sh' | tr -d '[:space:]')"
SNAPSHOT_SIZE="$(sandbox_exec sh -c 'wc -c < /tmp/nemoclaw-proxy-env.sh' | tr -d '[:space:]')"
if [ -z "$SNAPSHOT_B64" ] || [ -z "$SNAPSHOT_SIZE" ] || [ "$SNAPSHOT_SIZE" -eq 0 ]; then
  fail "proxy-env.sh is empty/missing already — cannot run negative case"
  exit 1
fi
info "Snapshotted proxy-env.sh ($SNAPSHOT_SIZE bytes, ${#SNAPSHOT_B64}-char base64)"

# Remove proxy-env.sh, kill the entire openclaw process tree, trigger
# recovery, expect WARNING. We must kill the launcher AND the gateway —
# pkill -9 -f '[o]penclaw' takes them all out so the launcher's watchdog
# can't silently respawn the gateway before nemoclaw status runs the
# recovery script (which is the only path that emits the warning).
sandbox_exec sh -c 'rm -f /tmp/nemoclaw-proxy-env.sh' >/dev/null
sandbox_exec sh -c "pkill -9 -f '[o]penclaw' 2>/dev/null; sleep 2; pgrep -af '[o]penclaw' || echo ALL_DEAD" >/dev/null
timeout 60 nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1 || true

# The new gateway.log should contain the [gateway-recovery] WARNING line.
warn_seen=false
for _ in 1 2 3 4 5; do
  if gateway_log_tail 100 | grep -q '\[gateway-recovery\] WARNING'; then
    warn_seen=true
    break
  fi
  sleep 3
done
if $warn_seen; then
  pass "Recovery emitted [gateway-recovery] WARNING when proxy-env.sh missing"
else
  fail "Recovery silently launched without warning (regression of #2478 fix)"
  gateway_log_tail 100
fi

# Restore proxy-env.sh by base64-injecting the snapshot via argv. `openshell
# sandbox exec` does not pipe stdin from the caller through to the subshell,
# so a `printf | sandbox_exec sh -c 'cat > file'` would leave an empty file.
# Encoding into the command argv sidesteps the stdin gap entirely.
sandbox_exec sh -c "echo '$SNAPSHOT_B64' | base64 -d > /tmp/nemoclaw-proxy-env.sh && chmod 444 /tmp/nemoclaw-proxy-env.sh" >/dev/null

# Verify restore is byte-identical to the snapshot.
restored_size="$(sandbox_exec sh -c 'wc -c < /tmp/nemoclaw-proxy-env.sh' | tr -d '[:space:]')"
if [ "$restored_size" != "$SNAPSHOT_SIZE" ]; then
  fail "proxy-env.sh restore failed: expected $SNAPSHOT_SIZE bytes, got '${restored_size}'"
  exit 1
fi
info "proxy-env.sh restored (${restored_size} bytes verified)"

# Trigger recovery to bring the gateway back with guards intact.
timeout 60 nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1 || true
SOAK_START_PID="$(wait_for_gateway_up 30)"
if [ -z "$SOAK_START_PID" ]; then
  fail "Gateway not up entering soak phase"
  gateway_diagnostics ""
  exit 1
fi
# Confirm the restored gateway has guards back in place — otherwise the
# soak measures a crash-looping gateway, not steady-state recovery.
if ! gateway_guards_active "$SOAK_START_PID" 30; then
  fail "Gateway up but guards not active entering soak — restore did not take"
  gateway_diagnostics "$SOAK_START_PID"
  exit 1
fi
if ! gateway_serves_inference 30; then
  fail "Gateway alive + guards active but inference API not serving entering soak"
  gateway_diagnostics "$SOAK_START_PID"
  exit 1
fi
pass "Gateway healthy with guards active and inference API serving (pid=$SOAK_START_PID)"

# ══════════════════════════════════════════════════════════════════
# Phase 5: Soak — verify no crash-loop over $SOAK_SECONDS
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Soak ($SOAK_SECONDS s) — detect crash-loop regression"

info "Sleeping ${SOAK_SECONDS}s while observing gateway. Health-monitor restart"
info "cadence is ~240s in prod, so a $SOAK_SECONDS s window catches at least one cycle."

# Sample PID every 15s + probe the inference endpoint every 60s. Count
# distinct PIDs, empty PID samples (gateway down), and inference-endpoint
# failures. The endpoint probe is the user-facing signal — pre-fix the
# ciao crash made `inference.local/v1/models` go silent for the user
# even though the underlying OS process state was variously alive/dead.
declare -a SAMPLES=()
empty_samples=0
inference_probes=0
inference_failures=0
elapsed=0
INTERVAL=15
while [ "$elapsed" -lt "$SOAK_SECONDS" ]; do
  cur="$(gateway_pid)"
  SAMPLES+=("$cur")
  [ -z "$cur" ] && empty_samples=$((empty_samples + 1))
  if [ $((elapsed % 60)) -eq 0 ]; then
    inference_probes=$((inference_probes + 1))
    if ! gateway_serves_inference 5; then
      inference_failures=$((inference_failures + 1))
    fi
  fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

# Distinct non-empty PIDs.
distinct=$(printf '%s\n' "${SAMPLES[@]}" | grep -v '^$' | sort -u | wc -l | tr -d ' ')
total_samples=${#SAMPLES[@]}

info "Soak summary: ${total_samples} samples, ${distinct} distinct PID(s), ${empty_samples} empty observations, ${inference_failures}/${inference_probes} inference probes failed"

# Crash-loop signature: many distinct PIDs (>2 over 5min = bad). One respawn
# (distinct=2) is acceptable if health-monitor fires once. Empty samples >1
# indicate the gateway was actually down for >15s, which is also bad.
if [ "$distinct" -le 2 ] && [ "$empty_samples" -le 1 ]; then
  pass "No crash-loop detected during soak ($distinct distinct PIDs, $empty_samples empty samples)"
else
  fail "Crash-loop signature: $distinct distinct PIDs and $empty_samples empty samples in ${SOAK_SECONDS}s"
  printf '  PID samples: %s\n' "${SAMPLES[*]}"
  gateway_log_tail 120
fi

# Inference-API availability: this is the user-facing failure surface from
# the #2478 comment ("deployed model not available because curl returns
# nothing"). Zero failures across the soak proves recovery preserves the
# user-visible service, not just the OS process.
if [ "$inference_failures" -eq 0 ]; then
  pass "Inference API available throughout soak ($inference_probes/$inference_probes probes succeeded)"
else
  fail "Inference API unavailable during soak ($inference_failures/$inference_probes probes failed)"
  gateway_log_tail 120
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Cleanup"

[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Issue #2478 crash-loop recovery e2e:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  PASS — gateway recovery preserves library guards under repeated kill-respawn and idle soak.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
