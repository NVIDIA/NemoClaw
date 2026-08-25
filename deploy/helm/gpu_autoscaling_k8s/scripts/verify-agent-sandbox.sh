#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Verify an existing CPU-only sandbox for the agent selected by AGENT_NAME
# (openclaw | hermes | deepagents) can reach on-premises inference through OpenShell's
# https://inference.local route (Envoy LeastRequest when enabled), and that the agent
# itself is healthy.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   AGENT_NAME=hermes ./scripts/verify-agent-sandbox.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=versions.env
source "${CHART_DIR}/versions.env"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

log() {
  echo "[verify] $*"
}

command -v openshell >/dev/null 2>&1 || fail "missing command: openshell"
command -v python3 >/dev/null 2>&1 || fail "missing command: python3"
command -v timeout >/dev/null 2>&1 || fail "missing command: timeout"
command -v grep >/dev/null 2>&1 || fail "missing command: grep"
command -v mktemp >/dev/null 2>&1 || fail "missing command: mktemp"

AGENT_NAME="${AGENT_NAME:-}"
agent_common_validate "${AGENT_NAME}"
AGENT_DISPLAY_NAME="$(agent_common_display_name "${AGENT_NAME}")"
RUN_MODE="$(agent_common_run_mode "${AGENT_NAME}")"

ACTUAL_OPENSHELL_VERSION="$(openshell --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
[[ "${ACTUAL_OPENSHELL_VERSION}" == "${OPENSHELL_VERSION}" ]] \
  || fail "OpenShell CLI ${OPENSHELL_VERSION} is required; found ${ACTUAL_OPENSHELL_VERSION:-unknown}"

SANDBOX_NAME="${AGENT_SANDBOX_NAME:-$(agent_common_default_sandbox_name "${AGENT_NAME}")}"
MODEL="${INFERENCE_MODEL:-llama3.2:3b}"
# Health/version/smoke commands can hang on a cold/busy gateway; keep them short.
HEALTH_TIMEOUT_SEC="${VERIFY_HEALTH_TIMEOUT_SEC:-90}"
SMOKE_TIMEOUT_SEC="${VERIFY_SMOKE_TIMEOUT_SEC:-30}"
CURL_TIMEOUT_SEC="${VERIFY_CURL_TIMEOUT_SEC:-120}"
OPENCLAW_TIMEOUT_SEC="${VERIFY_OPENCLAW_TIMEOUT_SEC:-120}"
HERMES_TIMEOUT_SEC="${VERIFY_HERMES_TIMEOUT_SEC:-120}"
DCODE_TIMEOUT_SEC="${VERIFY_DCODE_TIMEOUT_SEC:-120}"

for timeout_var in \
  HEALTH_TIMEOUT_SEC SMOKE_TIMEOUT_SEC CURL_TIMEOUT_SEC \
  OPENCLAW_TIMEOUT_SEC HERMES_TIMEOUT_SEC DCODE_TIMEOUT_SEC; do
  [[ "${!timeout_var}" =~ ^[1-9][0-9]*$ ]] \
    || fail "${timeout_var} must be a positive integer"
done

sandbox_exec() {
  local timeout_sec="${1:?timeout}"
  shift
  timeout --foreground "${timeout_sec}" openshell sandbox exec -n "${SANDBOX_NAME}" --no-tty -- "$@"
}

AGENT_STDERR_FILE="$(mktemp)"
trap 'rm -f -- "${AGENT_STDERR_FILE}"' EXIT
capture_agent_output() {
  local timeout_sec="${1:?timeout}"
  shift
  : >"${AGENT_STDERR_FILE}"
  ANSWER="$(sandbox_exec "${timeout_sec}" "$@" 2>"${AGENT_STDERR_FILE}")"
}

log "Checking OpenShell gateway connection..."
openshell status >/dev/null \
  || fail "OpenShell gateway is not connected; port-forward service/openshell and re-register the gateway"

log "Checking sandbox ${SANDBOX_NAME}..."
openshell sandbox get "${SANDBOX_NAME}" >/dev/null 2>&1 \
  || fail "sandbox ${SANDBOX_NAME} does not exist; run AGENT_NAME=${AGENT_NAME} ./scripts/create-agent-sandbox.sh first"

log "Checking sandbox policy does not allow NVIDIA-hosted inference..."
EFFECTIVE_POLICY="$(openshell policy get "${SANDBOX_NAME}" --full -o json)"
if grep -Fq 'integrate.api.nvidia.com' <<<"${EFFECTIVE_POLICY}"; then
  fail "effective sandbox policy still permits NVIDIA-hosted inference"
fi
unset EFFECTIVE_POLICY

case "${AGENT_NAME}" in
  openclaw)
    log "Inspecting nemoclaw plugin (timeout ${HEALTH_TIMEOUT_SEC}s)..."
    if ! sandbox_exec "${HEALTH_TIMEOUT_SEC}" openclaw plugins inspect nemoclaw --json >/dev/null; then
      fail "openclaw plugins inspect nemoclaw timed out or failed after ${HEALTH_TIMEOUT_SEC}s"
    fi
    log "Plugin inspect OK."
    ;;
  hermes)
    log "Checking hermes --version (timeout ${HEALTH_TIMEOUT_SEC}s)..."
    if ! sandbox_exec "${HEALTH_TIMEOUT_SEC}" hermes --version >/dev/null; then
      fail "hermes --version timed out or failed after ${HEALTH_TIMEOUT_SEC}s"
    fi
    log "hermes --version OK."

    # NOT a gateway health probe: OpenShell keeps sandboxes idle (`sleep infinity`) until
    # run-agent-sandbox.sh execs nemoclaw-start in the foreground, so nothing listens on
    # Hermes's gateway port (8642) at verify time. Confirm the build-time-generated config
    # is present instead (mirrors the deepagents config.toml check below).
    log "Checking config.yaml was generated (timeout ${SMOKE_TIMEOUT_SEC}s)..."
    CONFIG_CHECK="$(
      sandbox_exec "${SMOKE_TIMEOUT_SEC}" \
        bash -c 'test -s /sandbox/.hermes/config.yaml && echo NEMOCLAW_HERMES_CONFIG_OK'
    )" || fail "config.yaml smoke check timed out or failed after ${SMOKE_TIMEOUT_SEC}s"
    [[ "${CONFIG_CHECK}" == "NEMOCLAW_HERMES_CONFIG_OK" ]] \
      || fail "config.yaml smoke check returned unexpected output: ${CONFIG_CHECK}"
    log "config.yaml OK."
    ;;
  deepagents)
    log "Checking dcode --version (timeout ${SMOKE_TIMEOUT_SEC}s)..."
    if ! sandbox_exec "${SMOKE_TIMEOUT_SEC}" dcode --version >/dev/null; then
      fail "dcode --version timed out or failed after ${SMOKE_TIMEOUT_SEC}s"
    fi
    log "dcode --version OK."

    log "Checking config.toml was generated (timeout ${SMOKE_TIMEOUT_SEC}s)..."
    CONFIG_CHECK="$(
      sandbox_exec "${SMOKE_TIMEOUT_SEC}" \
        bash -c 'test -s /sandbox/.deepagents/config.toml && echo NEMOCLAW_DEEPAGENTS_CONFIG_OK'
    )" || fail "config.toml smoke check timed out or failed after ${SMOKE_TIMEOUT_SEC}s"
    [[ "${CONFIG_CHECK}" == "NEMOCLAW_DEEPAGENTS_CONFIG_OK" ]] \
      || fail "config.toml smoke check returned unexpected output: ${CONFIG_CHECK}"
    log "config.toml OK."
    ;;
esac

if [[ "${RUN_MODE}" == "gateway" ]]; then
  GATEWAY_HEALTH_URL="$(agent_common_gateway_health_url "${AGENT_NAME}")"
  log "Waiting for ${AGENT_DISPLAY_NAME} gateway at ${GATEWAY_HEALTH_URL} (timeout ${HEALTH_TIMEOUT_SEC}s)..."
  GATEWAY_HEALTH_CODE="$(
    sandbox_exec "$((HEALTH_TIMEOUT_SEC + 5))" \
      bash -c '
        deadline=$((SECONDS + $2))
        while ((SECONDS < deadline)); do
          code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "$1" 2>/dev/null || true)"
          case "${code}" in
            200 | 401) printf "%s" "${code}"; exit 0 ;;
          esac
          sleep 1
        done
        exit 1
      ' _ "${GATEWAY_HEALTH_URL}" "${HEALTH_TIMEOUT_SEC}"
  )" || fail "${AGENT_DISPLAY_NAME} gateway did not become healthy; start AGENT_NAME=${AGENT_NAME} ./scripts/run-agent-sandbox.sh first"
  log "Gateway health OK (HTTP ${GATEWAY_HEALTH_CODE})."
fi

log "GET https://inference.local/v1/models (timeout ${CURL_TIMEOUT_SEC}s)..."
MODELS_JSON="$(
  sandbox_exec "${CURL_TIMEOUT_SEC}" \
    curl -fsS --max-time "${CURL_TIMEOUT_SEC}" https://inference.local/v1/models
)" || fail "GET /v1/models timed out or failed after ${CURL_TIMEOUT_SEC}s"
python3 -c 'import json,sys; expected=sys.argv[1]; payload=json.loads(sys.argv[2]); ids=[item.get("id") for item in payload.get("data") or []];
assert expected in ids, f"inference.local /v1/models missing {expected!r}; got {ids!r}";
print("models:", ", ".join(ids))' \
  "${MODEL}" "${MODELS_JSON}"

QUERY='In one sentence, what is an AI agent sandbox?'
# Exercise the actual agent binary/CLI for every agent, not a curl probe of the inference
# endpoint — the /v1/models GET above already proves that route is reachable, so a second
# curl here (as OpenClaw/Hermes previously used) would only re-prove routing, not that the
# agent itself can answer through its own runtime. Each case uses that project's own
# documented headless, non-interactive entry point. OpenClaw uses its running gateway.
case "${AGENT_NAME}" in
  openclaw)
    log "openclaw agent --agent main -m (headless) — this is the real agent binary, not a curl probe (timeout ${OPENCLAW_TIMEOUT_SEC}s)"
    log "Example query: ${QUERY}"
    capture_agent_output "${OPENCLAW_TIMEOUT_SEC}" openclaw agent --agent main -m "${QUERY}" \
      || fail "openclaw agent timed out or failed after ${OPENCLAW_TIMEOUT_SEC}s"
    ;;
  hermes)
    log "hermes -z (headless) — this is the real agent binary, not a curl probe (timeout ${HERMES_TIMEOUT_SEC}s)"
    log "Example query: ${QUERY}"
    capture_agent_output "${HERMES_TIMEOUT_SEC}" hermes -z "${QUERY}" \
      || fail "hermes -z timed out or failed after ${HERMES_TIMEOUT_SEC}s"
    ;;
  deepagents)
    log "dcode -n (headless) — this is the real agent binary, not a curl probe (timeout ${DCODE_TIMEOUT_SEC}s)"
    log "Example query: ${QUERY}"
    capture_agent_output "${DCODE_TIMEOUT_SEC}" dcode -n "${QUERY}" \
      || fail "dcode -n timed out or failed after ${DCODE_TIMEOUT_SEC}s"
    ;;
esac
AGENT_STDERR="$(<"${AGENT_STDERR_FILE}")"
if agent_common_output_has_embedded_fallback "${ANSWER}"$'\n'"${AGENT_STDERR}"; then
  fail "${AGENT_DISPLAY_NAME} reported embedded fallback instead of using its managed gateway"
fi
[[ -n "${ANSWER}" ]] || fail "${AGENT_DISPLAY_NAME} returned an empty response"
[[ -z "${AGENT_STDERR}" ]] || printf '%s\n' "${AGENT_STDERR}" >&2
log "Answer: ${ANSWER}"

echo "OK: sandbox ${SANDBOX_NAME} reached https://inference.local for models and answered a real prompt through ${AGENT_DISPLAY_NAME} (${MODEL})."
if [[ "${RUN_MODE}" == "gateway" ]]; then
  echo "Runtime: ${AGENT_DISPLAY_NAME} gateway is healthy; keep run-agent-sandbox.sh attached."
else
  echo "${AGENT_DISPLAY_NAME} has no long-running gateway; run one-shot prompts with:"
  echo "  AGENT_NAME=${AGENT_NAME} ./scripts/run-agent-prompt.sh \"your prompt here\""
fi
