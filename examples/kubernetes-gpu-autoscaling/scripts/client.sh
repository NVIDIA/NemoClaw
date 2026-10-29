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
# One client for both HPA metrics. Both stop at 8. Demo defaults come
# from the live metric. Latency drops to short prompts at 6 GPUs.
# Latency: E2E_USERS=5 ./scripts/client.sh
# GPU util: INFLIGHT=4 MAX_TOKENS=2048 E2E_USERS=5 ./scripts/client.sh
#   E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client.sh
# UI user N: http://dgx-ip:$((18789+N))/u/0
# Both paths send chat.send to published :18789+i. They do not copy a load
# helper into the sandbox. The DGX path pauses HPA scale-down during the
# climb. OpenClaw stays up after stop for later use;
# ./scripts/uninstall-e2e.sh removes it.

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
agent_common_export_demo_workload
agent_common_export_client_tokens openclaw
agent_common_export_client_inflight
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-120}"
# Stop new chats as soon as HPA reaches 7. Extra send time at 8 left
# thousands of leftover Ollama completions and 8→1 bounced.
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-0}"
# Do not pause between chats: a 3s gap kept latency under 3000 ms at 1 GPU.
export E2E_CHAT_PAUSE_SEC="${E2E_CHAT_PAUSE_SEC:-0}"
# Start all users at once so 1→8 does not wait on a stagger.
export E2E_USER_STAGGER_SEC="${E2E_USER_STAGGER_SEC:-0}"
# After stop-new-chats, wait for already-sent chats to get a reply.
export E2E_DRAIN_SEC="${E2E_DRAIN_SEC:-${E2E_PROMPT_TIMEOUT_SEC:-180}}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
export E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/openclaw-ollama}"
E2E_CLIENT_HOST="${E2E_CLIENT_HOST:-}"

command -v python3 >/dev/null 2>&1 || fail "missing command: python3"
[[ "${E2E_USERS}" =~ ^[1-9][0-9]*$ ]] || fail "E2E_USERS must be a positive integer"

if [[ -n "${E2E_CLIENT_HOST}" ]]; then
  agent_common_print_laptop_client_usage "client.sh"
  echo "Client HTTP: ${E2E_USERS} end users -> ${E2E_CLIENT_HOST}:18789 ... $((18789 + E2E_USERS - 1))"
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
    print(f"  user {i} -> {url}")
if failed:
    raise SystemExit("client will not send chat until every http://dgx-ip:18789+i/health answers")
print(f"UI (one port per user): http://{host}:18789/u/0 ... :{18789 + users - 1}/u/0")
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
  --scale-down-wait-loops "${SCALE_DOWN_WAIT_LOOPS}" \
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
echo "Client: ${E2E_USERS} end users -> ${E2E_USERS} OpenShell sandboxes (1:1)."
agent_common_print_load_banner "${DURATION_SEC}" "${MAX_REPLICAS_HOLD_SEC}"
missing=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  if ! kubectl get pod "${name}" -n "${OPENSHELL_NAMESPACE}" >/dev/null 2>&1; then
    echo "ERROR: sandbox ${i} does not exist (user ${i}). Run ./scripts/agentscaling_gpuutil.sh or ./scripts/agentscaling_latency.sh first." >&2
    missing=1
    continue
  fi
  echo "  user ${i} -> sandbox ${i} :18789"
done
((missing == 0)) || fail "clients do not create sandboxes; start them with ./scripts/agentscaling_gpuutil.sh or ./scripts/agentscaling_latency.sh"

unhealthy=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  port=$((18789 + i))
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
  case "${code}" in
    200 | 401)
      echo "  user ${i} -> http://127.0.0.1:${port}/health"
      ;;
    *)
      echo "ERROR: http://127.0.0.1:${port}/health HTTP ${code:-down}. Run agentscaling_gpuutil.sh or agentscaling_latency.sh so :18789+i is published." >&2
      unhealthy=1
      ;;
  esac
done
((unhealthy == 0)) || fail "client will not send chat until every http://127.0.0.1:18789+i/health answers"

for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  agent_common_pin_openclaw_max_tokens "${name}" \
    || fail "could not pin max_tokens on sandbox ${i}"
done
# OpenClaw gateway.reload=off: this pin lands in openclaw.json for the next
# start of the OpenClaw agent. Do not stop that agent; leave it for later chats.
# OpenClaw process name gateway, not the OpenShell gateway.

mkdir -p "${E2E_OUTPUT_DIR}"
agent_common_start_hpa_timeline "${E2E_OUTPUT_DIR}" 0
cd "${CHART_DIR}" || fail "cannot cd to ${CHART_DIR}"
hpa_common_arm_hpa_for_client "${NAMESPACE}" "${HPA_NAME}" "${TARGET_PODS:-8}"
# Pause 8→1 only during 1→8. A new idle GPU-util replica at 0% would
# otherwise bounce the count. The load test resumes scale-down as soon as
# HPA reaches 8. The EXIT trap resumes again if the client stops early.
_hpa_metric="$(agent_common_hpa_metric)"
case "${_hpa_metric}" in
  *gpu_utilization* | gpu)
    hpa_common_set_dcgm_peak_window 90 || true
    hpa_common_pause_hpa_scale_down "${NAMESPACE}" "${HPA_NAME}"
    ;;
  *latency*)
    hpa_common_pause_hpa_scale_down "${NAMESPACE}" "${HPA_NAME}"
    ;;
esac
# shellcheck disable=SC2317 # EXIT trap calls this; ShellCheck cannot see that.
_client_finish() {
  hpa_common_resume_hpa_scale_down "${NAMESPACE}" "${HPA_NAME}" || true
  case "${_hpa_metric:-}" in
    *gpu_utilization* | gpu)
      hpa_common_set_dcgm_peak_window 15 || true
      ;;
  esac
  # OpenClaw stays up for later use. Do not pin maxReplicas=1: HPA must
  # walk 8→1. Tear down with uninstall-e2e.sh.
}
trap '_client_finish' EXIT
load_args=(
  "${SCRIPT_DIR}/e2e-openclaw-ollama-load-test.py"
  --users "${E2E_USERS}"
  --prefix "${SANDBOX_PREFIX}"
  --output "${E2E_OUTPUT_DIR}"
  --duration "${DURATION_SEC}"
  --inflight-per-user "${E2E_INFLIGHT_PER_USER}"
  --inflight-start "${E2E_INFLIGHT_START_PER_USER}"
  --target-pods "${TARGET_PODS}"
  --hold-sec "${MAX_REPLICAS_HOLD_SEC}"
  --hpa-namespace "${NAMESPACE}"
  --hpa-name "${HPA_NAME}"
  --scale-down-wait-loops "${SCALE_DOWN_WAIT_LOOPS}"
  --host 127.0.0.1
  --chat-only
)
load_rc=0
python3 "${load_args[@]}" || load_rc=$?
exit "${load_rc}"
