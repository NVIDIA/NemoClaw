#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# End-user client for the Hermes + vLLM e2e. One simulated user per
# sandbox (1:1). user-i sends hermes -z into sandbox hermes-vllm-e2e-00i.
# Clients do not build images, create sandboxes, start gateways, or set
# the HPA metric. hermes -z does not need :8642.
#
# Provision first (other terminal):
#   ./scripts/agentscaling_hermes_gpuutil.sh   # GPU util HPA
#   ./scripts/agentscaling_hermes_latency.sh   # LLM latency HPA (same client)
#
# Default: 3 users, inflight 1, 4Gi sandboxes. 2Gi + inflight 2 OOMed dgx-19.
#
# Laptop HTTP: UI http://dgx-ip:18789/  CLI user i → http://dgx-ip:8642+i/v1
#   E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client_hermes.sh
# Workload: inflight stays 1. Both metrics start at 2048 tokens.
# Latency HPA ramps 2048 until 6 GPUs, then 32, then stops at 8.
# GPU util keeps 2048 until 8, then stops.

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
export E2E_USERS="${E2E_USERS:-3}"
export SANDBOX_PREFIX="${SANDBOX_PREFIX:-hermes-vllm-e2e-}"
export INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-$(agent_common_default_inference_runtime hermes)}"
agent_common_validate_inference_runtime "${INFERENCE_RUNTIME}"
export OPENSHELL_NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export HPA_NAME="${HPA_NAME:-nemoclaw-gpu-metrics-proxy}"
export TARGET_PODS="${TARGET_PODS:-8}"
export DURATION_SEC="${DURATION_SEC:-900}"
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-180}"
export E2E_INFLIGHT_START_PER_USER="${E2E_INFLIGHT_START_PER_USER:-1}"
export E2E_INFLIGHT_PER_USER="${E2E_INFLIGHT_PER_USER:-1}"
MAX_TOKENS_FROM_USER="${MAX_TOKENS-}"
export MAX_TOKENS="$(agent_common_resolve_max_tokens hermes)"
# Both metrics stop new chats at 8 GPUs. GPU util keeps 2048 until then.
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-0}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/hermes}"
E2E_CLIENT_HOST="${E2E_CLIENT_HOST:-}"

command -v python3 >/dev/null 2>&1 || fail "missing command: python3"
[[ "${E2E_USERS}" =~ ^[1-9][0-9]*$ ]] || fail "E2E_USERS must be a positive integer"

if [[ -n "${E2E_CLIENT_HOST}" ]]; then
  agent_common_print_laptop_client_usage "client_hermes.sh"
  echo "Client HTTP: ${E2E_USERS} end users → ${E2E_CLIENT_HOST}:8642 … $((8642 + E2E_USERS - 1))/v1"
  echo "UI (sandbox 0): http://${E2E_CLIENT_HOST}:18789/"
  echo "Sends chats for ${DURATION_SEC}s. Latency: 2048 until 6 GPUs, 32, then 0 at 8. GPU util: 2048 until 8, then 0."
  python3 - "${E2E_CLIENT_HOST}" "${E2E_USERS}" "${DURATION_SEC}" "${E2E_PROMPT_TIMEOUT_SEC}" "${MAX_TOKENS}" "${TARGET_PODS}" "${SCRIPT_DIR}" <<'PY'
import json, os, sys, time, urllib.error, urllib.request
host, users, duration, timeout, max_tokens, target = (
    sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
)
sys.path.insert(0, sys.argv[7])
import e2e_latency_load_ramp as ramp
discovery = int(os.environ.get("E2E_DISCOVERY_PORT", "18788"))
deadline = time.monotonic() + duration
failed = 0
for i in range(users):
    url = f"http://{host}:{8642 + i}/health"
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
    print(f"  user {i} → http://{host}:{8642 + i}/v1")
if failed:
    raise SystemExit("client will not send chat until every http://dgx-ip:8642+i/health answers")

def hpa_status():
    try:
        with urllib.request.urlopen(f"http://{host}:{discovery}/hpa", timeout=3) as resp:
            data = json.loads(resp.read().decode())
        if not isinstance(data, dict):
            return 0, 0, ""
        current = int(data.get("current") or 0)
        desired = int(data.get("desired") or 0)
        metric = str(data.get("metric") or "")
        return current, desired, metric
    except Exception:
        return 0, 0, ""

current, desired, metric = hpa_status()
use_ramp = os.environ.get("E2E_LATENCY_RAMP") != "0"
last = "unset"
if use_ramp:
    start_load = ramp.scale_load(metric, 1, target=target)
    max_tokens = ramp.load_tokens(start_load) or ramp.token_bands()[0]
    if ramp.is_latency_metric(metric):
        print(
            f"[load] max_tokens={max_tokens} until 6 GPUs, "
            f"then {ramp.token_bands()[1]}, then 0 at {target}",
            flush=True,
        )
    else:
        print(
            f"[load] max_tokens={max_tokens} until {target} GPUs, then 0 new chats",
            flush=True,
        )
    last = max_tokens
prompts = ramp.prompt_for_tokens(max_tokens, "hermes") if use_ramp else (
    ["In one sentence, what is Kubernetes HPA?"] if max_tokens <= 128
    else ["Explain Kubernetes HPA and GPU autoscaling in detail with examples."]
)

ok = err = 0
turn = 0
while time.monotonic() < deadline:
    current, desired, metric = hpa_status()
    if use_ramp:
        load = ramp.scale_load(
            metric, ramp.effective_replicas(current, desired), target=target
        )
        tokens = ramp.load_tokens(load)
        if tokens != last:
            last = tokens
            if tokens is None:
                break
            max_tokens = tokens
            prompts = ramp.prompt_for_tokens(max_tokens, "hermes")
            print(f"[load] max_tokens={tokens}", flush=True)
    for i in range(users):
        if time.monotonic() >= deadline:
            break
        prompt = prompts[turn % len(prompts)]
        turn += 1
        req = urllib.request.Request(
            f"http://{host}:{8642 + i}/v1/chat/completions",
            data=json.dumps({
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "stream": False,
            }).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                json.loads(resp.read().decode())
            ok += 1
            print(f"[user {i}] ok={ok} err={err}", flush=True)
        except Exception as exc:
            err += 1
            print(f"[user {i}] {exc}", flush=True)
print(f"[load] done ok={ok} err={err}", flush=True)
raise SystemExit(0 if ok else 1)
PY
  exit $?
fi

command -v openshell >/dev/null 2>&1 \
  || agent_common_fail_openshell_for_client "missing command: openshell"
command -v kubectl >/dev/null 2>&1 || fail "missing command: kubectl"
command -v python3 >/dev/null 2>&1 || fail "missing command: python3"

[[ "${E2E_USERS}" =~ ^[1-9][0-9]*$ ]] || fail "E2E_USERS must be a positive integer"
openshell status >/dev/null \
  || agent_common_fail_openshell_for_client "OpenShell is not connected on this host"
hpa_common_require_live_runtime "${NAMESPACE}" "${HPA_NAME}" "${INFERENCE_RUNTIME}" \
  || fail "client_hermes.sh will not send chats until GPU pods are ${INFERENCE_RUNTIME}. Re-run agentscaling_hermes_* with INFERENCE_RUNTIME=${INFERENCE_RUNTIME}."

export E2E_CLIENT_QUIET_HPA=1
agent_common_print_laptop_client_usage "client_hermes.sh"
echo "Client: ${E2E_USERS} end users → ${E2E_USERS} OpenShell sandboxes (1:1 hermes -z)."
echo "Sends chats for ${DURATION_SEC}s. Latency: 2048 until 6 GPUs, 32, then 0 at 8. GPU util: 2048 until 8, then 0."
missing=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  if ! kubectl get pod "${name}" -n "${OPENSHELL_NAMESPACE}" >/dev/null 2>&1; then
    echo "ERROR: sandbox ${i} does not exist (user ${i}). Run ./scripts/agentscaling_hermes_gpuutil.sh or ./scripts/agentscaling_hermes_latency.sh first." >&2
    missing=1
    continue
  fi
  echo "  user ${i} → sandbox ${i} hermes -z"
done
((missing == 0)) || fail "clients do not create sandboxes; start them with ./scripts/agentscaling_hermes_gpuutil.sh or ./scripts/agentscaling_hermes_latency.sh"

echo "Checking each sandbox pod is Running"
unhealthy=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  phase="$(kubectl get pod "${name}" -n "${OPENSHELL_NAMESPACE}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  ready="$(kubectl get pod "${name}" -n "${OPENSHELL_NAMESPACE}" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null || true)"
  if [[ "${phase}" == "Running" && "${ready}" == "true" ]]; then
    echo "  sandbox ${i}: Ready"
  else
    echo "ERROR: sandbox ${i} is not Ready (phase=${phase:-missing} ready=${ready:-missing}). Run agentscaling_hermes_gpuutil.sh or agentscaling_hermes_latency.sh." >&2
    unhealthy=1
  fi
done
((unhealthy == 0)) || fail "client will not send chat until every sandbox pod is Ready"

echo "Pinning Hermes max_tokens=${MAX_TOKENS} (keep provisioned model; one hermes -z per sandbox)"
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  agent_common_pin_hermes_max_tokens "${name}" \
    || fail "could not pin max_tokens on sandbox ${i}"
done

mkdir -p "${E2E_OUTPUT_DIR}"
cd "${CHART_DIR}" || fail "cannot cd to ${CHART_DIR}"
hpa_common_hold_hpa_until_client "${NAMESPACE}" "${HPA_NAME}" "${HPA_NAME}" "${TARGET_PODS:-8}" \
  || fail "HPA is not 1 current replica; leftover load would scale before chats start"
hpa_common_arm_hpa_for_client "${NAMESPACE}" "${HPA_NAME}" "${TARGET_PODS:-8}"
exec python3 "${SCRIPT_DIR}/e2e-hermes-load-test.py" \
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
