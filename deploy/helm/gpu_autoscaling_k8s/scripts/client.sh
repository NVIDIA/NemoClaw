#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# End-user client for the OpenClaw + Ollama e2e. One simulated user per
# sandbox (1:1). user-i sends chat.send to sandbox i
# on that sandbox's :18789. Clients do not build images, create sandboxes,
# start OpenClaw, or set the HPA metric.
#
# Provision first (other terminal):
#   ./scripts/agentscaling_gpuutil.sh
#   ./scripts/agentscaling_latency.sh
#
# Default — from a remote terminal such as your laptop (HTTP):
#   E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client.sh
#   UI user N: http://dgx-ip:$((18789+N))/u/0
#
# simpler option — from the same DGX in another terminal:
#   E2E_USERS=5 ./scripts/client.sh
# Workload: inflight stays 1. Default MAX_TOKENS=1024 (GPU util).
# Latency HPA overrides to 64. Set MAX_TOKENS only to force a value.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

export PATH="${HOME}/.local/bin:${PATH}"
export E2E_USERS="${E2E_USERS:-5}"
export SANDBOX_PREFIX="${SANDBOX_PREFIX:-openclaw-ollama-e2e-}"
export INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-$(agent_common_default_inference_runtime openclaw)}"
agent_common_validate_inference_runtime "${INFERENCE_RUNTIME}"
export OPENSHELL_NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export HPA_NAME="${HPA_NAME:-nemoclaw-gpu-metrics-proxy}"
export TARGET_PODS="${TARGET_PODS:-8}"
export DURATION_SEC="${DURATION_SEC:-900}"
MAX_TOKENS_FROM_USER="${MAX_TOKENS-}"
export MAX_TOKENS_FROM_USER
export MAX_TOKENS="$(agent_common_resolve_max_tokens openclaw)"
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-600}"
export E2E_INFLIGHT_START_PER_USER="${E2E_INFLIGHT_START_PER_USER:-1}"
export E2E_INFLIGHT_PER_USER="${E2E_INFLIGHT_PER_USER:-1}"
# Clients keep sending chats for DURATION_SEC. Do not abort at 8 GPUs.
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-0}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/openclaw-ollama}"
E2E_CLIENT_HOST="${E2E_CLIENT_HOST:-}"

command -v python3 >/dev/null 2>&1 || fail "missing command: python3"
[[ "${E2E_USERS}" =~ ^[1-9][0-9]*$ ]] || fail "E2E_USERS must be a positive integer"

if [[ -n "${E2E_CLIENT_HOST}" ]]; then
  agent_common_print_laptop_client_usage "client.sh"
  echo "Client HTTP: ${E2E_USERS} end users → ${E2E_CLIENT_HOST}:18789 … $((18789 + E2E_USERS - 1))"
  echo "Sends chats for ${DURATION_SEC}s. HPA scales on live latency. Queries are not dropped at 8 GPUs."
  python3 - "${E2E_CLIENT_HOST}" "${E2E_USERS}" "${E2E_DISCOVERY_PORT:-18788}" <<'PY'
import json, sys, urllib.error, urllib.request
host, users, discovery = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
failed = 0
for i in range(users):
    url = f"http://{host}:{18789 + i}/health"
    try:
        code = urllib.request.urlopen(url, timeout=3).status
    except urllib.error.HTTPError as exc:
        code = exc.code
    except Exception as exc:
        print(f"ERROR: user {i} {url}: {exc}", file=sys.stderr)
        failed = 1
        continue
    if code not in (200, 401):
        print(f"ERROR: user {i} {url} HTTP {code}", file=sys.stderr)
        failed = 1
        continue
    print(f"  user {i} → {url}")
if failed:
    raise SystemExit("client will not send chat until every http://dgx-ip:18789+i/health answers")
hpa_url = f"http://{host}:{discovery}/hpa"
try:
    data = json.loads(urllib.request.urlopen(hpa_url, timeout=5).read().decode())
    if isinstance(data, dict):
        current = int(data.get("current") or 0)
        desired = int(data.get("desired") or 0)
        metric = str(data.get("metric") or "")
        print(f"  HPA {hpa_url} current={current} desired={desired} metric={metric or '?'}")
except Exception as exc:
    print(f"  HPA {hpa_url} unavailable ({exc}); continuing chats for DURATION_SEC")
print(f"UI (one port per user): http://{host}:18789/u/0 … :{18789 + users - 1}/u/0")
PY
  mkdir -p "${E2E_OUTPUT_DIR}"
  cd "${CHART_DIR}" || fail "cannot cd to ${CHART_DIR}"
  exec python3 "${SCRIPT_DIR}/e2e-openclaw-ollama-load-test.py" \
    --users "${E2E_USERS}" \
    --prefix "${SANDBOX_PREFIX}" \
    --output "${E2E_OUTPUT_DIR}" \
    --duration "${DURATION_SEC}" \
    --inflight-per-user "${E2E_INFLIGHT_PER_USER}" \
    --inflight-start "${E2E_INFLIGHT_START_PER_USER}" \
    --target-pods "${TARGET_PODS}" \
    --hold-sec "${MAX_REPLICAS_HOLD_SEC}" \
    --hpa-namespace "${NAMESPACE}" \
    --hpa-name "${HPA_NAME}" \
    --scale-down-wait-loops 0 \
    --host "${E2E_CLIENT_HOST}" \
    --chat-only
fi

command -v openshell >/dev/null 2>&1 \
  || agent_common_fail_openshell_for_client "missing command: openshell"
command -v kubectl >/dev/null 2>&1 || fail "missing command: kubectl"

openshell status >/dev/null \
  || agent_common_fail_openshell_for_client "OpenShell is not connected on this host"
hpa_common_require_live_runtime "${NAMESPACE}" "${HPA_NAME}" "${INFERENCE_RUNTIME}" \
  || fail "client.sh will not send chats until GPU pods are ${INFERENCE_RUNTIME}. Re-run agentscaling_* with INFERENCE_RUNTIME=${INFERENCE_RUNTIME}."

export E2E_CLIENT_QUIET_HPA=1
agent_common_print_laptop_client_usage "client.sh"
echo "Client: ${E2E_USERS} end users → ${E2E_USERS} OpenShell sandboxes (1:1)."
echo "Sends chats for ${DURATION_SEC}s. HPA scales on live latency. Queries are not dropped at 8 GPUs."
missing=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  if ! kubectl get pod "${name}" -n "${OPENSHELL_NAMESPACE}" >/dev/null 2>&1; then
    echo "ERROR: sandbox ${i} does not exist (user ${i}). Run ./scripts/agentscaling_gpuutil.sh or ./scripts/agentscaling_latency.sh first." >&2
    missing=1
    continue
  fi
  echo "  user ${i} → sandbox ${i} :18789"
done
((missing == 0)) || fail "clients do not create sandboxes; start them with ./scripts/agentscaling_gpuutil.sh or ./scripts/agentscaling_latency.sh"

echo "Checking each sandbox listens on :18789 (do not send chat if this fails)"
unhealthy=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  # curl %{http_code} is literal; do not expand it in the sandbox shell.
  # shellcheck disable=SC2016
  # shellcheck disable=SC2016 # remote script: $ns/$code must expand inside the sandbox
  if kubectl exec -n "${OPENSHELL_NAMESPACE}" "${name}" -c agent -- bash -c '
    for ns in /run/netns/*; do
      [ -e "$ns" ] || continue
      code="$(nsenter --net="$ns" curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/health 2>/dev/null || true)"
      case "$code" in 200|401) exit 0 ;; esac
    done
    exit 1
  ' >/dev/null 2>&1; then
    echo "  sandbox ${i}: :18789 up"
  else
    echo "ERROR: sandbox ${i} is Running but OpenClaw is not listening on :18789. Run agentscaling_gpuutil.sh or agentscaling_latency.sh start." >&2
    unhealthy=1
  fi
done
((unhealthy == 0)) || fail "client will not send chat until every sandbox listens on :18789"

echo "Pinning OpenClaw max_tokens=${MAX_TOKENS} (keep provisioned model; one chat.send per sandbox)"
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  agent_common_pin_openclaw_max_tokens "${name}" \
    || fail "could not pin max_tokens on sandbox ${i}"
done

mkdir -p "${E2E_OUTPUT_DIR}"
cd "${CHART_DIR}" || fail "cannot cd to ${CHART_DIR}"
hpa_common_hold_hpa_until_client "${NAMESPACE}" "${HPA_NAME}" "${HPA_NAME}" "${TARGET_PODS:-8}" \
  || fail "HPA is not 1 current replica; leftover load would scale before chats start"
hpa_common_arm_hpa_for_client "${NAMESPACE}" "${HPA_NAME}" "${TARGET_PODS:-8}"
exec python3 "${SCRIPT_DIR}/e2e-openclaw-ollama-load-test.py" \
  --users "${E2E_USERS}" \
  --prefix "${SANDBOX_PREFIX}" \
  --output "${E2E_OUTPUT_DIR}" \
  --duration "${DURATION_SEC}" \
  --inflight-per-user "${E2E_INFLIGHT_PER_USER}" \
  --inflight-start "${E2E_INFLIGHT_START_PER_USER}" \
  --target-pods "${TARGET_PODS}" \
  --hold-sec "${MAX_REPLICAS_HOLD_SEC}" \
  --hpa-namespace "${NAMESPACE}" \
  --hpa-name "${HPA_NAME}" \
  --scale-down-wait-loops "${SCALE_DOWN_WAIT_LOOPS}"
