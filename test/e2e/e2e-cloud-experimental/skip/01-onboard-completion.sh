#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Check 01: onboard completion baseline (post-install smoke gate).
#
# Scenario:
#   Run after non-interactive install/onboard in e2e-cloud-experimental.
#   This check confirms the environment is usable before deeper network/security checks.
#
# What this check verifies:
#   1) Core CLIs respond: `nemoclaw --help`, `openshell --help`.
#   2) `nemoclaw list` includes the target sandbox.
#   3) `nemoclaw <sandbox> status` succeeds.
#   4) `nemoclaw <sandbox> connect` can open a shell and exit immediately.
#   5) OpenShell sees the sandbox: `openshell sandbox get <sandbox>` succeeds.
#   6) OpenShell list contains the sandbox name.
#   7) `openclaw --help`, `openclaw agent --help`, and `openclaw skills list` succeed inside sandbox.
#   8) `openshell inference get` shows the expected provider (default nvidia-nim; VDR3 #12) and model.
#
# Requires:
#   nemoclaw, openshell, openclaw on PATH.
#
# Env (optional — defaults match test-e2e-cloud-experimental.sh):
#   SANDBOX_NAME or NEMOCLAW_SANDBOX_NAME (default: e2e-cloud-experimental)
#   CLOUD_EXPERIMENTAL_MODEL (legacy: SCENARIO_A_MODEL, NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL, NEMOCLAW_SCENARIO_A_MODEL)
#   CLOUD_EXPERIMENTAL_INFERENCE_PROVIDER — substring matched in `openshell inference get` (default: nvidia-nim; e.g. ollama-local for local gateways)
#
# Example:
#   bash test/e2e/e2e-cloud-experimental/skip/01-onboard-completion.sh
#   SANDBOX_NAME=my-box CLOUD_EXPERIMENTAL_MODEL=nvidia/nemotron-3-super-120b-a12b bash ...
#   SANDBOX_NAME=test01 CLOUD_EXPERIMENTAL_INFERENCE_PROVIDER=ollama-local CLOUD_EXPERIMENTAL_MODEL=nemotron-3-nano:30b bash ...

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-experimental}}"
CLOUD_EXPERIMENTAL_MODEL="${CLOUD_EXPERIMENTAL_MODEL:-${SCENARIO_A_MODEL:-${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-${NEMOCLAW_SCENARIO_A_MODEL:-moonshotai/kimi-k2.5}}}}"
CLOUD_EXPERIMENTAL_INFERENCE_PROVIDER="${CLOUD_EXPERIMENTAL_INFERENCE_PROVIDER:-nvidia-nim}"
die() {
  printf '%s\n' "01-onboard-completion: FAIL: $*" >&2
  exit 1
}

set +e
nm_help=$(nemoclaw --help 2>&1)
nmh=$?
set -e
[ "$nmh" -eq 0 ] || die "nemoclaw --help failed: ${nm_help:0:200}"

set +e
os_help=$(openshell --help 2>&1)
osh=$?
set -e
[ "$osh" -eq 0 ] || die "openshell --help failed: ${os_help:0:200}"

set +e
list_output=$(nemoclaw list 2>&1)
lc=$?
set -e
[ "$lc" -eq 0 ] || die "nemoclaw list failed: ${list_output:0:200}"
echo "$list_output" | grep -Fq -- "$SANDBOX_NAME" \
  || die "nemoclaw list does not contain '${SANDBOX_NAME}'"

set +e
status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1)
st=$?
set -e
[ "$st" -eq 0 ] || die "nemoclaw ${SANDBOX_NAME} status failed (exit $st): ${status_output:0:200}"

CONNECT_TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && CONNECT_TIMEOUT_CMD="timeout 30"
command -v gtimeout >/dev/null 2>&1 && CONNECT_TIMEOUT_CMD="gtimeout 30"

set +e
connect_out=$(
  printf 'exit\n' | $CONNECT_TIMEOUT_CMD nemoclaw "$SANDBOX_NAME" connect 2>&1
)
cc=$?
set -e
[ "$cc" -eq 0 ] || die "nemoclaw ${SANDBOX_NAME} connect failed (exit $cc): ${connect_out:0:240}"

set +e
sb_get=$(openshell sandbox get "$SANDBOX_NAME" 2>&1)
sg=$?
set -e
[ "$sg" -eq 0 ] || die "openshell sandbox get ${SANDBOX_NAME} failed: ${sb_get:0:200}"

set +e
sb_list=$(openshell sandbox list 2>&1)
sl=$?
set -e
[ "$sl" -eq 0 ] || die "openshell sandbox list failed: ${sb_list:0:200}"
echo "$sb_list" | grep -Fq -- "$SANDBOX_NAME" \
  || die "openshell sandbox list does not contain '${SANDBOX_NAME}'"

ssh_config="$(mktemp)"
trap 'rm -f "$ssh_config"' EXIT
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null \
  || die "openshell sandbox ssh-config failed for '${SANDBOX_NAME}' (openclaw CLI check)"

set +e
oc_help=$(
  ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "openclaw --help" 2>&1
)
oc_rc=$?
set -e
[ "$oc_rc" -eq 0 ] || die "sandbox openclaw --help failed (exit $oc_rc): ${oc_help:0:200}"

set +e
oc_agent_help=$(
  ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "openclaw agent --help" 2>&1
)
oc_agent_rc=$?
set -e
[ "$oc_agent_rc" -eq 0 ] || die "sandbox openclaw agent --help failed (exit $oc_agent_rc): ${oc_agent_help:0:200}"

set +e
skills_list_out=$(
  ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "openclaw skills list" 2>&1
)
skills_list_rc=$?
set -e
[ "$skills_list_rc" -eq 0 ] || die "sandbox openclaw skills list failed (exit $skills_list_rc): ${skills_list_out:0:240}"

set +e
inf_check=$(openshell inference get 2>&1)
ig=$?
set -e
[ "$ig" -eq 0 ] || die "openshell inference get failed: ${inf_check:0:200}"
echo "$inf_check" | grep -Fqi "$CLOUD_EXPERIMENTAL_INFERENCE_PROVIDER" \
  || die "openshell inference get missing provider '${CLOUD_EXPERIMENTAL_INFERENCE_PROVIDER}' (set CLOUD_EXPERIMENTAL_INFERENCE_PROVIDER to match Gateway). Output (first 500 chars): ${inf_check:0:500}"
if ! echo "$inf_check" | grep -Fq "$CLOUD_EXPERIMENTAL_MODEL"; then
  die "inference model mismatch: expected substring '${CLOUD_EXPERIMENTAL_MODEL}' (from CLOUD_EXPERIMENTAL_MODEL / NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL) inside 'openshell inference get', but it was not found. If the sandbox was onboarded with another model, export the same id for this check (e.g. NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL=nvidia/nemotron-3-super-120b-a12b). --- openshell inference get (first 800 chars) --- ${inf_check:0:800}"
fi

printf '%s\n' "01-onboard-completion: OK (cli, list/status/connect, sandbox get/list, openclaw help/skills, inference + model)"
exit 0
