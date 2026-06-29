#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Opt-in live repro for #4434:
#   openclaw tui must show a visible error, and stop the active spinner, when
#   the NVIDIA endpoint is unreachable from the sandbox.
#
# This mutates host firewall state. Run only on a Linux Docker host you control:
#
#   NEMOCLAW_ISSUE_4434_LIVE=1 NVIDIA_INFERENCE_API_KEY=... \
#     bash test/e2e/test-issue-4434-tui-unreachable-inference.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=test/e2e/lib/ci-compatible-inference.sh
. "${SCRIPT_DIR}/lib/ci-compatible-inference.sh"

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-issue-4434-tui-unreachable}"
INSTALL_LOG="${E2E_ISSUE_4434_INSTALL_LOG:-/tmp/nemoclaw-e2e-issue-4434-install.log}"
CAPTURE_DIR="${NEMOCLAW_ISSUE_4434_CAPTURE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-issue-4434.XXXXXX")}"
CAPTURE_FILE="${CAPTURE_DIR}/openclaw-tui-capture.log"
PLAIN_CAPTURE_FILE="${CAPTURE_DIR}/openclaw-tui-capture.plain.log"
TUI_TIMEOUT_SEC="${NEMOCLAW_ISSUE_4434_TUI_TIMEOUT_SEC:-180}"
VISIBLE_ERROR_RE="error|failed|timeout|timed out|unavailable|fetch failed|ETIMEDOUT|ECONN|upstream"
SPINNER_CONNECTED_RE="flibbertigibbeting|[0-9]+m[[:space:]][0-9]+s[[:space:]]*\\|[[:space:]]*connected"
STATUS_LINE_RE="(connecting|gateway connected|connected|sending|running|flibbertigibbeting).*\\|[[:space:]]*(connected|error)"
BLOCKED_IPS=("75.2.113.119" "99.83.136.103")
INSERTED_IPS=()
CLEANUP_SANDBOX=0

info() { printf '[issue-4434] %s\n' "$*"; }
fail() {
  printf '[issue-4434] FAIL: %s\n' "$*" >&2
  printf '[issue-4434] capture: %s\n' "$CAPTURE_FILE" >&2
  exit 1
}

cleanup_firewall() {
  local ip
  for ip in "${INSERTED_IPS[@]}"; do
    sudo iptables -D DOCKER-USER -d "$ip" -j DROP >/dev/null 2>&1 || true
  done
}

cleanup_sandbox() {
  if [ "$CLEANUP_SANDBOX" != "1" ]; then
    return
  fi
  if [ "${NEMOCLAW_E2E_SKIP_CLEANUP:-0}" = "1" ]; then
    return
  fi
  SANDBOX_NAME="$SANDBOX_NAME" bash "${SCRIPT_DIR}/e2e-cloud-experimental/cleanup.sh" --verify >/dev/null 2>&1 || true
}

cleanup() {
  cleanup_firewall
  cleanup_sandbox
}
trap cleanup EXIT

if [ "${NEMOCLAW_ISSUE_4434_LIVE:-0}" != "1" ]; then
  info "skipping: set NEMOCLAW_ISSUE_4434_LIVE=1 to run the privileged live repro"
  exit 0
fi

if nemoclaw_e2e_using_compatible_inference; then
  info "skipping: hosted compatible inference is gateway-managed; this repro only blocks sandbox egress"
  exit 0
fi

if [ "$(uname -s)" != "Linux" ]; then
  fail "Linux host required for DOCKER-USER iptables repro"
fi
for command in docker sudo expect curl timeout perl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
docker info >/dev/null 2>&1 || fail "Docker is not running"
sudo -n true >/dev/null 2>&1 || fail "passwordless sudo is required for non-interactive iptables cleanup"
nemoclaw_e2e_configure_compatible_inference || fail "hosted CI inference could not be configured"
nemoclaw_e2e_require_hosted_inference_key || exit 1

mkdir -p "$CAPTURE_DIR"
CLEANUP_SANDBOX=1

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export E2E_CLOUD_ONBOARD_INSTALL_LOG="$INSTALL_LOG"
export NEMOCLAW_E2E_KEEP_SANDBOX=1
export NEMOCLAW_NON_INTERACTIVE="${NEMOCLAW_NON_INTERACTIVE:-1}"
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-1}"
export NEMOCLAW_RECREATE_SANDBOX="${NEMOCLAW_RECREATE_SANDBOX:-1}"
export NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL="${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-nvidia/nemotron-3-super-120b-a12b}"

info "onboarding sandbox ${SANDBOX_NAME} with ${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL}"
bash "${SCRIPT_DIR}/test-cloud-onboard-e2e.sh"

# Pick up PATH changes from the installer in this shell.
# shellcheck source=test/e2e/lib/install-path-refresh.sh
. "${SCRIPT_DIR}/lib/install-path-refresh.sh"
nemoclaw_refresh_install_env
nemoclaw_ensure_local_bin_on_path
export PATH="/usr/local/bin:${HOME}/.local/bin:${PATH}"
for command in nemoclaw openshell; do
  command -v "$command" >/dev/null 2>&1 || fail "missing installed command after onboard: $command"
done

openclaw_version="$(openshell sandbox exec --name "$SANDBOX_NAME" -- openclaw --version 2>&1 || true)"
info "sandbox OpenClaw version: ${openclaw_version}"
if ! grep -q "2026.5.27" <<<"$openclaw_version"; then
  fail "expected sandbox OpenClaw 2026.5.27"
fi

status_log="${CAPTURE_DIR}/nemoclaw-status-before-block.log"
if ! nemoclaw "$SANDBOX_NAME" status >"$status_log" 2>&1; then
  fail "nemoclaw ${SANDBOX_NAME} status failed before firewall block"
fi
if ! grep -Eiq "inference.*healthy|healthy.*inference" "$status_log"; then
  if grep -Eiq "Inference:[[:space:]]*not probed" "$status_log"; then
    info "status skipped inference reachability; probing inference.local directly"
  else
    fail "pre-block status did not report healthy or not-probed inference"
  fi
fi

route_log="${CAPTURE_DIR}/openshell-inference-before-block.log"
if ! route_output=$(openshell inference get 2>&1); then
  printf '%s\n' "$route_output" >"$route_log"
  fail "openshell inference get failed before firewall block"
fi
printf '%s\n' "$route_output" >"$route_log"
expected_provider="$(nemoclaw_e2e_expected_route_provider)"
expected_model="$(nemoclaw_e2e_hosted_inference_model)"
if ! nemoclaw_e2e_inference_output_matches "$route_output" "$expected_provider" "$expected_model"; then
  route_plain="$(printf '%s' "$route_output" | nemoclaw_e2e_strip_ansi)"
  fail "pre-block OpenShell route was not ${expected_provider} / ${expected_model}: ${route_plain:0:240}"
fi

preblock_probe_log="${CAPTURE_DIR}/inference-local-before-block.log"
preblock_payload="$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":8}' "$expected_model")"
preblock_payload_arg="$(printf '%q' "$preblock_payload")"
if ! timeout 90 openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
  "curl -sf --max-time 60 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d $preblock_payload_arg >/dev/null" \
  >"$preblock_probe_log" 2>&1; then
  fail "inference.local was not reachable from inside the sandbox before firewall block"
fi

connect_probe_log="${CAPTURE_DIR}/nemoclaw-connect-probe-before-block.log"
if ! nemoclaw "$SANDBOX_NAME" connect --probe-only >"$connect_probe_log" 2>&1; then
  fail "nemoclaw ${SANDBOX_NAME} connect --probe-only failed before firewall block"
fi

info "installing DOCKER-USER DROP rules for NVIDIA endpoint IPs"
for ip in "${BLOCKED_IPS[@]}"; do
  sudo iptables -I DOCKER-USER -d "$ip" -j DROP
  INSERTED_IPS+=("$ip")
done

block_probe_log="${CAPTURE_DIR}/blocked-endpoint-probe.log"
set +e
timeout 25 openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
  'curl -sk --connect-timeout 5 --max-time 12 https://inference-api.nvidia.com/v1/models >/tmp/issue4434-models.out 2>&1' \
  >"$block_probe_log" 2>&1
block_probe_rc=$?
set -e
if [ "$block_probe_rc" -eq 0 ]; then
  fail "inference-api.nvidia.com was still reachable from inside the sandbox after firewall block"
fi
info "sandbox endpoint block verified (probe exit ${block_probe_rc})"

info "launching openclaw tui through OpenShell sandbox exec --tty"
set +e
env \
  NEMOCLAW_ISSUE_4434_SANDBOX="$SANDBOX_NAME" \
  NEMOCLAW_ISSUE_4434_CAPTURE="$CAPTURE_FILE" \
  NEMOCLAW_ISSUE_4434_TUI_TIMEOUT="$TUI_TIMEOUT_SEC" \
  expect >"${CAPTURE_DIR}/expect.log" 2>&1 <<'EXPECT'
set timeout $env(NEMOCLAW_ISSUE_4434_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_ISSUE_4434_SANDBOX)
set capture $env(NEMOCLAW_ISSUE_4434_CAPTURE)
log_file -a $capture
spawn openshell sandbox exec --name $sandbox --tty -- sh -lc {export TERM=xterm-256color; cd /sandbox; openclaw tui}
sleep 10
send -- "hello\r"
expect {
  -nocase -re {(error|failed|timeout|timed out|unavailable|fetch failed|ETIMEDOUT|ECONN|upstream)} {
    sleep 5
    send "\003"
    sleep 1
    send "\003"
    exit 0
  }
  timeout {
    send "\003"
    sleep 1
    send "\003"
    exit 20
  }
  eof { exit 21 }
}
EXPECT
expect_rc=$?
set -e

perl -pe 's/\x1b\][^\a]*(?:\a|\x1b\\)//g; s/\x1b\[[0-9;?]*[ -\/]*[@-~]//g; s/\r/\n/g' \
  "$CAPTURE_FILE" >"$PLAIN_CAPTURE_FILE"

if ! grep -Eiq "$VISIBLE_ERROR_RE" "$PLAIN_CAPTURE_FILE"; then
  if grep -Eiq "$SPINNER_CONNECTED_RE" "$PLAIN_CAPTURE_FILE"; then
    fail "matched #4434 signature: spinner plus connected status with no visible error"
  fi
  fail "TUI did not surface a visible inference error before the timeout window"
fi
if [ "$expect_rc" -ne 0 ]; then
  fail "expect harness exited ${expect_rc} even though an error-looking capture was found"
fi
last_status_line="$(grep -E "$STATUS_LINE_RE" "$PLAIN_CAPTURE_FILE" | tail -1 || true)"
if [ -z "$last_status_line" ]; then
  fail "TUI capture did not include a recognizable final status line"
fi
if ! grep -Eiq "\\|[[:space:]]*error\\b" <<<"$last_status_line"; then
  if grep -Eiq "$SPINNER_CONNECTED_RE" <<<"$last_status_line"; then
    fail "TUI capture still ends with active connected spinner after the visible error"
  fi
  fail "TUI capture did not end with a visible error status after the failed run"
fi

info "PASS: openclaw tui surfaced a visible unreachable-inference error and stopped the spinner"
info "capture: ${PLAIN_CAPTURE_FILE}"
