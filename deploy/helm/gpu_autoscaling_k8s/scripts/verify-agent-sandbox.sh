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
#   cd examples/recipes/nvidia/kubernetes-gpu-autoscaling
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
DCODE_TIMEOUT_SEC="${VERIFY_DCODE_TIMEOUT_SEC:-120}"

sandbox_exec() {
  local timeout_sec="${1:?timeout}"
  shift
  timeout --foreground "${timeout_sec}" openshell sandbox exec -n "${SANDBOX_NAME}" --no-tty -- "$@"
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

    log "GET http://localhost:8642/health (timeout ${HEALTH_TIMEOUT_SEC}s)..."
    if ! sandbox_exec "${HEALTH_TIMEOUT_SEC}" curl -fsS --max-time "${HEALTH_TIMEOUT_SEC}" http://localhost:8642/health >/dev/null; then
      fail "Hermes health probe timed out or failed after ${HEALTH_TIMEOUT_SEC}s"
    fi
    log "Health probe OK."
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
if [[ "${RUN_MODE}" == "terminal" ]]; then
  log "dcode -n (headless) — this is the real agent binary, not a curl probe (timeout ${DCODE_TIMEOUT_SEC}s)"
  log "Example query: ${QUERY}"
  ANSWER="$(sandbox_exec "${DCODE_TIMEOUT_SEC}" dcode -n "${QUERY}")" \
    || fail "dcode -n timed out or failed after ${DCODE_TIMEOUT_SEC}s"
  [[ -n "${ANSWER}" ]] || fail "dcode -n returned an empty response"
else
  log "POST https://inference.local/v1/chat/completions"
  log "Example query: ${QUERY}"
  CHAT_JSON="$(
    sandbox_exec "${CURL_TIMEOUT_SEC}" \
      curl -fsS --max-time "${CURL_TIMEOUT_SEC}" https://inference.local/v1/chat/completions \
        -H 'Content-Type: application/json' \
        -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"${QUERY}\"}],\"max_tokens\":256,\"stream\":false}"
  )" || fail "POST /v1/chat/completions timed out or failed after ${CURL_TIMEOUT_SEC}s"
  ANSWER="$(
    python3 -c 'import json,sys; payload=json.loads(sys.argv[1]); choices=payload.get("choices") or [];
assert choices, f"chat/completions returned no choices: {payload!r}";
content=((choices[0].get("message") or {}).get("content") or "").strip();
assert content, "chat/completions returned an empty assistant message";
print(content)' "${CHAT_JSON}"
  )"
fi
log "Answer: ${ANSWER}"

echo "OK: sandbox ${SANDBOX_NAME} reached https://inference.local for models and a real prompt (${MODEL})."
if [[ "${RUN_MODE}" == "gateway" ]]; then
  echo "Runtime (optional foreground): AGENT_NAME=${AGENT_NAME} ./scripts/run-agent-sandbox.sh"
else
  echo "${AGENT_DISPLAY_NAME} has no long-running gateway; run one-shot prompts with:"
  echo "  AGENT_NAME=${AGENT_NAME} ./scripts/run-agent-prompt.sh \"your prompt here\""
fi
