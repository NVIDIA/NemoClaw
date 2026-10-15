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
#   E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 INFLIGHT=1 MAX_TOKENS=1024 ./scripts/client_hermes.sh
# Pass INFLIGHT and MAX_TOKENS on this client. Laptop and DGX use the same flags.
# GPU util demo: INFLIGHT=1 MAX_TOKENS=1024. Latency demo: INFLIGHT=3 MAX_TOKENS=64.
# Clients do not stop or restart Hermes. Sandboxes stay up after stop;
# ./scripts/uninstall-e2e.sh removes them.

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
INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-$(agent_common_default_inference_runtime hermes)}"
export INFERENCE_RUNTIME
agent_common_validate_inference_runtime "${INFERENCE_RUNTIME}"
export OPENSHELL_NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export HPA_NAME="${HPA_NAME:-nemoclaw-gpu-metrics-proxy}"
export TARGET_PODS="${TARGET_PODS:-8}"
export DURATION_SEC="${DURATION_SEC:-900}"
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-180}"
agent_common_export_client_tokens hermes
agent_common_export_client_inflight
# Stop new chats after a short sit at 8 GPUs.
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
  agent_common_print_load_banner "${DURATION_SEC}" "${MAX_REPLICAS_HOLD_SEC}"
  mkdir -p "${E2E_OUTPUT_DIR}"
  agent_common_start_hpa_timeline "${E2E_OUTPUT_DIR}" 0
  python3 - "${E2E_CLIENT_HOST}" "${E2E_USERS}" "${DURATION_SEC}" "${E2E_PROMPT_TIMEOUT_SEC}" "${MAX_TOKENS}" "${TARGET_PODS}" "${SCRIPT_DIR}" <<'PY'
import json, os, sys, threading, time, urllib.error, urllib.request
from pathlib import Path
host, users, duration, timeout, max_tokens, target = (
    sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
)
sys.path.insert(0, sys.argv[7])
import e2e_timeline as timeline
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

def user_token(uid):
    specific = (os.environ.get(f"E2E_HERMES_API_KEY_{uid}") or "").strip()
    if specific:
        return specific
    return (os.environ.get("E2E_HERMES_API_KEY") or os.environ.get("API_SERVER_KEY") or "").strip()
try:
    inflight = max(1, int(os.environ.get("INFLIGHT") or os.environ.get("E2E_INFLIGHT_PER_USER") or "1"))
except ValueError:
    inflight = 1
print(
    f"[load] max_tokens={max_tokens} inflight={inflight}; stop after hold at {max(1, target - 1)} GPUs",
    flush=True,
)
prompts = (
    ["In one sentence, what is Kubernetes HPA?"] if max_tokens <= 128
    else ["Explain Kubernetes HPA and GPU autoscaling in detail with examples."]
)

ok = err = 0
ok_by = [0] * users
err_by = [0] * users
tok_by = [0] * users
counts = threading.Lock()
client_log = Path(os.environ.get("E2E_OUTPUT_DIR") or ".") / "client-timeline.jsonl"
client_log.parent.mkdir(parents=True, exist_ok=True)
client_log.write_text("")
stop_tl = threading.Event()
stop_load = threading.Event()

def write_ticks():
    while not stop_tl.is_set():
        if stop_tl.wait(timeline.seconds_until_next_tick()):
            break
        try:
            timeline.write_client(
                client_log,
                max_tokens=max_tokens,
                inflight=inflight,
                users=[
                    {"user": i, "ok": ok_by[i], "err": err_by[i], "tokens": tok_by[i]}
                    for i in range(users)
                ],
            )
        except Exception:
            continue

def one_chat(uid):
    global ok, err
    headers = {"Content-Type": "application/json"}
    token = user_token(uid)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"http://{host}:{8642 + uid}/v1/chat/completions",
        data=json.dumps({
            "messages": [{"role": "user", "content": prompts[0]}],
            "max_tokens": max_tokens,
            "stream": False,
        }).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
        ntok = 0
        usage = body.get("usage") if isinstance(body, dict) else None
        if isinstance(usage, dict):
            try:
                ntok = int(usage.get("completion_tokens") or usage.get("total_tokens") or 0)
            except (TypeError, ValueError):
                ntok = 0
        with counts:
            ok += 1
            ok_by[uid] += 1
            tok_by[uid] += ntok
            print(f"[user {uid}] ok={ok} err={err}", flush=True)
    except Exception as exc:
        with counts:
            err += 1
            err_by[uid] += 1
            print(f"[user {uid}] {exc}", flush=True)

def worker(uid):
    while not stop_load.is_set() and time.monotonic() < deadline:
        one_chat(uid)

try:
    hold_sec = float(os.environ.get("MAX_REPLICAS_HOLD_SEC") or "0")
except ValueError:
    hold_sec = 15.0
at_max_since = None
hold_announced = False
tick_thread = threading.Thread(target=write_ticks, daemon=True)
tick_thread.start()
workers = [
    threading.Thread(target=worker, args=(i,), daemon=True)
    for i in range(users) for _ in range(inflight)
]
for thread in workers:
    thread.start()
try:
    while time.monotonic() < deadline and not stop_load.is_set():
        current, desired, _metric = hpa_status()
        stop_at = max(1, target - 1)
        at_target = max(current, desired) >= stop_at
        if at_target:
            now = time.monotonic()
            if at_max_since is None:
                at_max_since = now
                if not hold_announced:
                    hold_announced = True
                    print(
                        f"[load] {stop_at} GPUs — stop new chats; already-sent chats keep running",
                        flush=True,
                    )
            if (now - at_max_since) >= hold_sec:
                break
        else:
            at_max_since = None
        time.sleep(1)
finally:
    stop_load.set()
    stop_tl.set()
    for thread in workers:
        thread.join(timeout=2)
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
agent_common_print_load_banner "${DURATION_SEC}" "${MAX_REPLICAS_HOLD_SEC}"
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
agent_common_start_hpa_timeline "${E2E_OUTPUT_DIR}" 0
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
