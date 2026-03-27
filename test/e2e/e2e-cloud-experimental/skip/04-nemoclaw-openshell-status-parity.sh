#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: nemoclaw registry / CLI view matches OpenShell JSON (bug 5982550).
#
# Sandbox “running” signal (OpenShell versions differ):
#   1) openshell sandbox status <name> --json → .state == running (nemoclaw plugin status path)
#   2) else openshell sandbox list → row for name contains Ready (bin/lib/onboard.js isSandboxReady)
# Inference model: prefer openshell inference get --json .model; else plain inference get
# (text) must contain nvidia-nim + CLOUD_EXPERIMENTAL_MODEL (same idea as 01-onboard-completion.sh).
# nemoclaw list model must match openshell model (JSON or CLOUD_EXPERIMENTAL_MODEL text path).
#
# Requires: node on PATH (for JSON + list parsing; same shell as post-install suite).

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-experimental}}"
CLOUD_EXPERIMENTAL_MODEL="${CLOUD_EXPERIMENTAL_MODEL:-${SCENARIO_A_MODEL:-${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-${NEMOCLAW_SCENARIO_A_MODEL:-moonshotai/kimi-k2.5}}}}"
export SANDBOX_NAME

die() {
  printf '%s\n' "04-nemoclaw-openshell-status-parity: FAIL: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || die "node not on PATH (needed to parse --json and nemoclaw list)"

# ── OpenShell: sandbox lifecycle ─────────────────────────────────────
sandbox_lifecycle_ok=0
set +e
st_raw=$(openshell sandbox status "$SANDBOX_NAME" --json 2>&1)
st_rc=$?
set -e
if [ "$st_rc" -eq 0 ]; then
  state=$(printf '%s' "$st_raw" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).state" 2>/dev/null) \
    || die "could not parse openshell sandbox status JSON"
  if [ "$state" = "running" ]; then
    sandbox_lifecycle_ok=1
  else
    die "openshell sandbox status JSON state is '${state}', expected running"
  fi
fi

if [ "$sandbox_lifecycle_ok" -ne 1 ]; then
  set +e
  list_raw=$(openshell sandbox list 2>&1)
  list_rc=$?
  set -e
  [ "$list_rc" -eq 0 ] || die "openshell sandbox status --json failed (exit $st_rc): ${st_raw:0:200}; and sandbox list failed (exit $list_rc): ${list_raw:0:200}"

  printf '%s' "$list_raw" | node -e '
const name = process.env.SANDBOX_NAME;
let d = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => {
  const clean = d.replace(/\x1b\[[0-9;]*m/g, "");
  const ok = clean.split("\n").some((l) => {
    const cols = l.trim().split(/\s+/);
    return cols[0] === name && cols.includes("Ready") && !cols.includes("NotReady");
  });
  process.exit(ok ? 0 : 1);
});
' || die "openshell sandbox not Ready in \`sandbox list\` (status --json unavailable or failed: exit $st_rc, ${st_raw:0:200})"
fi

# ── OpenShell: inference ─────────────────────────────────────────────
os_model=""
set +e
inf_raw=$(openshell inference get --json 2>&1)
inf_rc=$?
set -e
if [ "$inf_rc" -eq 0 ] && [ -n "$inf_raw" ]; then
  os_model=$(printf '%s' "$inf_raw" | node -p "try { String(JSON.parse(require('fs').readFileSync(0,'utf8')).model || '') } catch (e) { '' }" 2>/dev/null || true)
fi

if [ -z "$os_model" ]; then
  set +e
  inf_raw=$(openshell inference get 2>&1)
  inf_rc=$?
  set -e
  [ "$inf_rc" -eq 0 ] || die "openshell inference get failed (exit $inf_rc): ${inf_raw:0:240}"
  echo "$inf_raw" | grep -qi "nvidia-nim" \
    || die "openshell inference get (text) missing nvidia-nim. Output (first 500 chars): ${inf_raw:0:500}"
  if ! echo "$inf_raw" | grep -Fq "$CLOUD_EXPERIMENTAL_MODEL"; then
    die "inference model (text path): expected substring '${CLOUD_EXPERIMENTAL_MODEL}' in 'openshell inference get' (set NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL to match onboarded model). --- output (first 800 chars) --- ${inf_raw:0:800}"
  fi
  os_model="$CLOUD_EXPERIMENTAL_MODEL"
else
  [ "$os_model" = "$CLOUD_EXPERIMENTAL_MODEL" ] \
    || die "inference model mismatch: openshell inference get --json .model is '${os_model}', expected '${CLOUD_EXPERIMENTAL_MODEL}' (align CLOUD_EXPERIMENTAL_MODEL / NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL with gateway)"
fi

# ── NemoClaw: list output must agree with OpenShell inference model ──
set +e
nm_list=$(nemoclaw list 2>&1)
nm_rc=$?
set -e
[ "$nm_rc" -eq 0 ] || die "nemoclaw list failed (exit $nm_rc): ${nm_list:0:240}"

# shellcheck disable=SC2016
# JavaScript source for node -e; single quotes intentional
nm_model=$(printf '%s' "$nm_list" | node -e '
const name = process.env.SANDBOX_NAME;
let d = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^\\s+" + esc + "(?:\\s+\\*)?\\s*\\n\\s+model:\\s+(\\S+)", "m");
  const m = d.match(re);
  if (!m) {
    console.error("could not find model: line under sandbox name in nemoclaw list");
    process.exit(1);
  }
  process.stdout.write(m[1]);
});
') || die "failed to extract model from nemoclaw list"

[ "$nm_model" = "$os_model" ] \
  || die "parity: nemoclaw list model '${nm_model}' != openshell inference model '${os_model}'"

# ── nemoclaw <sandbox> status still succeeds (human + embedded openshell get) ──
set +e
st_out=$(nemoclaw "$SANDBOX_NAME" status 2>&1)
st_rc=$?
set -e
[ "$st_rc" -eq 0 ] || die "nemoclaw ${SANDBOX_NAME} status failed (exit $st_rc): ${st_out:0:240}"

printf '%s\n' "04-nemoclaw-openshell-status-parity: OK (sandbox running, model parity, status exits 0)"
exit 0
