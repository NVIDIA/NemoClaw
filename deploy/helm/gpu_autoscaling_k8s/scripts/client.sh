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
# Both paths send chat.send from this client to published :18789+i.
# They do not copy a load helper into the sandbox.
# Same client for both HPA metrics. GPU util does not take MAX_TOKENS
# (built-in 4096) and uses three in-flight chats on the one OpenClaw per
# sandbox. Latency: MAX_TOKENS=64 ./scripts/client.sh (inflight 1).

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
INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-$(agent_common_default_inference_runtime openclaw)}"
export INFERENCE_RUNTIME
agent_common_validate_inference_runtime "${INFERENCE_RUNTIME}"
export OPENSHELL_NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export HPA_NAME="${HPA_NAME:-nemoclaw-gpu-metrics-proxy}"
export TARGET_PODS="${TARGET_PODS:-8}"
export DURATION_SEC="${DURATION_SEC:-900}"
agent_common_export_client_tokens openclaw
agent_common_export_client_inflight openclaw
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-600}"
# Stop new chats after ~60s at 8 GPUs.
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-60}"
# Do not drain in-flight chat.send after SIGTERM. That leftover generation
# kept GPUs busy after the client stopped.
export E2E_DRAIN_SEC="${E2E_DRAIN_SEC:-0}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/openclaw-ollama}"
E2E_CLIENT_HOST="${E2E_CLIENT_HOST:-}"

command -v python3 >/dev/null 2>&1 || fail "missing command: python3"
[[ "${E2E_USERS}" =~ ^[1-9][0-9]*$ ]] || fail "E2E_USERS must be a positive integer"

if [[ -n "${E2E_CLIENT_HOST}" ]]; then
  agent_common_print_laptop_client_usage "client.sh"
  echo "Client HTTP: ${E2E_USERS} end users → ${E2E_CLIENT_HOST}:18789 … $((18789 + E2E_USERS - 1))"
  agent_common_print_load_banner "${DURATION_SEC}" "${MAX_REPLICAS_HOLD_SEC}"
  python3 - "${E2E_CLIENT_HOST}" "${E2E_USERS}" <<'PY'
import sys, urllib.error, urllib.request
host, users = sys.argv[1], int(sys.argv[2])
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
print(f"UI (one port per user): http://{host}:18789/u/0 … :{18789 + users - 1}/u/0")
PY
mkdir -p "${E2E_OUTPUT_DIR}"
agent_common_start_hpa_timeline "${E2E_OUTPUT_DIR}" 0
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
agent_common_print_load_banner "${DURATION_SEC}" "${MAX_REPLICAS_HOLD_SEC}"
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

echo "Checking published host ports :18789+i (same path as the laptop client)"
unhealthy=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  port=$((18789 + i))
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
  case "${code}" in
    200 | 401)
      echo "  user ${i} → http://127.0.0.1:${port}/health"
      ;;
    *)
      echo "ERROR: http://127.0.0.1:${port}/health HTTP ${code:-down}. Run agentscaling_gpuutil.sh or agentscaling_latency.sh so :18789+i is published." >&2
      unhealthy=1
      ;;
  esac
done
((unhealthy == 0)) || fail "client will not send chat until every http://127.0.0.1:18789+i/health answers"

echo "Pinning OpenClaw max_tokens=${MAX_TOKENS} on the live gateway (file watch is off)"
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  agent_common_pin_openclaw_max_tokens "${name}" \
    || fail "could not pin max_tokens on sandbox ${i}"
done
# gateway.reload=off: SIGHUP does not apply max_tokens. Restart the process
# so 4096 is live before chats start. A file-only pin left the previous
# latency 64-token gateway running and GPU util stayed bursty.
echo "Restarting OpenClaw so max_tokens=${MAX_TOKENS} is live"
"${SCRIPT_DIR}/setup-openclaw-ollama-e2e-sandboxes.sh" stop \
  || fail "could not stop OpenClaw after max_tokens pin"
SKIP_WAIT_INFERENCE_LOCAL=1 "${SCRIPT_DIR}/setup-openclaw-ollama-e2e-sandboxes.sh" start \
  || fail "could not restart OpenClaw after max_tokens pin"
echo "Waiting for :18789 after OpenClaw restart"
agent_common_wait_published_openclaw_health "${E2E_USERS}" \
  || fail "OpenClaw did not come back on :18789 after max_tokens pin"

mkdir -p "${E2E_OUTPUT_DIR}"
agent_common_start_hpa_timeline "${E2E_OUTPUT_DIR}" 0
cd "${CHART_DIR}" || fail "cannot cd to ${CHART_DIR}"
hpa_common_hold_hpa_until_client "${NAMESPACE}" "${HPA_NAME}" "${HPA_NAME}" "${TARGET_PODS:-8}" \
  || fail "HPA is not 1 current replica; leftover load would scale before chats start"
hpa_common_arm_hpa_for_client "${NAMESPACE}" "${HPA_NAME}" "${TARGET_PODS:-8}"
# GPU util: keep scale-up only until 8 so a new 0% GPU cannot bounce 3→2 during the climb.
# Resume scale-down when the client exits so 8→1 can start after the 60s hold.
_hpa_metric="$(agent_common_hpa_metric)"
case "${_hpa_metric}" in
  *gpu_utilization* | gpu)
    hpa_common_set_dcgm_peak_window 90 || true
    hpa_common_pause_hpa_scale_down "${NAMESPACE}" "${HPA_NAME}"
    ;;
esac
_client_load_started=0
_client_finish() {
  hpa_common_resume_hpa_scale_down "${NAMESPACE}" "${HPA_NAME}" || true
  case "${_hpa_metric:-}" in
    *gpu_utilization* | gpu)
      hpa_common_set_dcgm_peak_window 15 || true
      ;;
  esac
  if [[ "${_client_load_started}" != "1" ]]; then
    return 0
  fi
  # Drop leftover OpenClaw→Ollama work. Closing the client WS does not
  # abort stream=false completions. Do not pin maxReplicas=1: HPA must
  # walk 8→1 in about two minutes after the 60s sit-at-8 hold.
  echo "Restarting idle OpenClaw so leftover chats cannot keep GPUs busy"
  # Stop first: start reuses a healthy gateway and would leave Ollama running.
  # Skip inference.local pings so this restart does not generate GPU load.
  "${SCRIPT_DIR}/setup-openclaw-ollama-e2e-sandboxes.sh" stop \
    || echo "WARNING: could not stop OpenClaw after load" >&2
  SKIP_WAIT_INFERENCE_LOCAL=1 "${SCRIPT_DIR}/setup-openclaw-ollama-e2e-sandboxes.sh" start \
    || echo "WARNING: could not restart OpenClaw after load; leftover chats may keep GPUs busy" >&2
}
trap '_client_finish' EXIT
_client_load_started=1
load_rc=0
python3 "${SCRIPT_DIR}/e2e-openclaw-ollama-load-test.py" \
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
  --host 127.0.0.1 \
  --chat-only || load_rc=$?
exit "${load_rc}"
