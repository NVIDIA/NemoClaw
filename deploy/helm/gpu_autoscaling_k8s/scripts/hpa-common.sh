#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Shared helpers for nemoclaw-gpu HPA scripts

hpa_common_log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Kubernetes custom metrics use Quantity milli-units (33500m = 33.5). Format as plain % for scripts.
# Style: script (GPU UTIL % column + subtitle) | kubectl (matches kubectl get hpa TARGETS column).
hpa_common_format_hpa() {
  local ns="${1:?namespace}"
  local headers="${2:-1}"
  local style="${3:-script}"
  python3 - "${ns}" "${headers}" "${style}" <<'PY'
import json, subprocess, sys
from datetime import datetime, timezone

ns, headers = sys.argv[1], sys.argv[2] == "1"
style = sys.argv[3] if len(sys.argv) > 3 else "script"

def qty(raw):
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s == "<unknown>":
        return None
    if s.endswith("m"):
        return float(s[:-1]) / 1000.0
    return float(s)

def fmt_pct(n):
    if n is None:
        return "<unknown>"
    if abs(n - round(n)) < 1e-6:
        return f"{int(round(n))}%"
    s = f"{n:.2f}".rstrip("0").rstrip(".")
    return f"{s}%"

def age(ts):
    if not ts:
        return "?"
    created = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    secs = int((datetime.now(timezone.utc) - created).total_seconds())
    if secs < 60:
        return f"{secs}s"
    if secs < 3600:
        return f"{secs // 60}m"
    if secs < 86400:
        return f"{secs // 3600}h"
    return f"{secs // 86400}d"

def targets(h):
    spec_metrics = h.get("spec", {}).get("metrics") or []
    current = h.get("status", {}).get("currentMetrics") or []
    parts = []
    for i, sm in enumerate(spec_metrics):
        mtype = sm.get("type")
        cm = current[i] if i < len(current) else {}
        if mtype == "Pods":
            name = sm["pods"]["metric"]["name"]
            target = sm["pods"]["target"]
            tgt_raw = target.get("averageValue") or target.get("value")
            cur_raw = (cm.get("pods") or {}).get("current", {})
            cur_raw = cur_raw.get("averageValue") or cur_raw.get("value")
            if name == "gpu_utilization_percent":
                parts.append(f"{fmt_pct(qty(cur_raw))}/{fmt_pct(qty(tgt_raw))}")
            else:
                cur = cur_raw if cur_raw not in (None, "") else "<unknown>"
                parts.append(f"{cur}/{tgt_raw}")
        elif mtype == "Resource":
            res = sm["resource"]["name"]
            target = sm["resource"]["target"]
            cur_res = (cm.get("resource") or {}).get("current", {})
            if target.get("type") == "Utilization":
                cur = cur_res.get("averageUtilization")
                tgt = target.get("averageUtilization")
                cur_s = f"{cur}%" if cur is not None else "<unknown>"
                parts.append(f"{res}: {cur_s}/{tgt}%")
            else:
                cur = cur_res.get("averageValue") or cur_res.get("value")
                tgt = target.get("averageValue") or target.get("value")
                parts.append(f"{res}: {cur or '<unknown>'}/{tgt}")
    return " ".join(parts) if parts else "<unknown>"

def print_row(h):
    meta = h["metadata"]
    spec = h["spec"]
    status = h.get("status") or {}
    ref = spec["scaleTargetRef"]
    ref_str = f"{ref['kind']}/{ref['name']}"
    tgt = targets(h)
    if style == "kubectl":
        print(
            f"{meta['name']:<20} "
            f"{ref_str:<31} "
            f"{tgt:<11} "
            f"{spec.get('minReplicas', ''):<9} "
            f"{spec.get('maxReplicas', ''):<9} "
            f"{status.get('currentReplicas', ''):<10} "
            f"{age(meta.get('creationTimestamp'))}"
        )
    else:
        print(
            f"{meta['name']:<22} "
            f"{ref_str:<31} "
            f"{tgt:<18} "
            f"{spec.get('minReplicas', ''):<8} "
            f"{spec.get('maxReplicas', ''):<8} "
            f"{status.get('currentReplicas', ''):<10} "
            f"{age(meta.get('creationTimestamp'))}"
        )

try:
    raw = subprocess.check_output(
        ["kubectl", "get", "hpa", "-n", ns, "-o", "json"],
        stderr=subprocess.DEVNULL,
        text=True,
    )
    items = json.loads(raw).get("items") or []
except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError):
    sys.exit(1)

if not items:
    sys.exit(1)

if headers:
    if style == "kubectl":
        print(
            f"{'NAME':<20} {'REFERENCE':<31} {'TARGETS':<11} "
            f"{'MINPODS':<9} {'MAXPODS':<9} {'REPLICAS':<10} AGE"
        )
    else:
        print("GPU utilization rate (avg per pod): current / target")
        print(
            f"{'NAME':<22} {'REFERENCE':<31} {'GPU UTIL %':<18} "
            f"{'MINPODS':<8} {'MAXPODS':<8} {'REPLICAS':<10} AGE"
        )

for h in items:
    print_row(h)
PY
}

# Autoscaling-only stdout: GPU utilization as 30.25%/40% (not kubectl milli-units).
hpa_common_print_hpa() {
  local ns="${1:?namespace}"
  if ! hpa_common_format_hpa "${ns}" 1 "script"; then
    kubectl get hpa -n "${ns}" 2>/dev/null || true
  fi
}

# Agent pods + per-pod GPU % (same namespace as HPA).
hpa_common_print_agent_pods() {
  local ns="${1:?namespace}"
  python3 - "${ns}" <<'PY'
import json, subprocess, sys

ns = sys.argv[1]

def qty(raw):
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s == "<unknown>":
        return None
    if s.endswith("m"):
        return float(s[:-1]) / 1000.0
    return float(s)

def fmt_pct(n):
    if n is None:
        return "<unknown>"
    if abs(n - round(n)) < 1e-6:
        return f"{int(round(n))}%"
    s = f"{n:.2f}".rstrip("0").rstrip(".")
    return f"{s}%"

def age(ts):
    if not ts:
        return "?"
    from datetime import datetime, timezone
    created = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    secs = int((datetime.now(timezone.utc) - created).total_seconds())
    if secs < 60:
        return f"{secs}s"
    if secs < 3600:
        return f"{secs // 60}m"
    if secs < 86400:
        return f"{secs // 3600}h"
    return f"{secs // 86400}d"

gpu = {}
try:
    raw = subprocess.check_output(
        [
            "kubectl", "get", "--raw",
            f"/apis/custom.metrics.k8s.io/v1beta1/namespaces/{ns}/pods/*/gpu_utilization_percent",
        ],
        stderr=subprocess.DEVNULL,
        text=True,
    )
    for item in json.loads(raw).get("items") or []:
        pod = item.get("describedObject", {}).get("name", "")
        gpu[pod] = fmt_pct(qty(item.get("value")))
except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError):
    pass

try:
    raw = subprocess.check_output(
        [
            "kubectl", "get", "pods", "-n", ns,
            "-l", "app.kubernetes.io/name=nemoclaw-gpu,component=gpu-agent",
            "-o", "json",
        ],
        stderr=subprocess.DEVNULL,
        text=True,
    )
    items = json.loads(raw).get("items") or []
except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError):
    items = []

print()
print("Agent pods (avg GPU util per pod):")
if not items:
    print("  (no gpu-agent pods)")
else:
    print(
        f"{'NAME':<42} {'READY':<7} {'STATUS':<11} {'RESTARTS':<9} "
        f"{'GPU UTIL':<10} AGE"
    )
    for pod in sorted(items, key=lambda p: p["metadata"]["name"]):
        meta = pod["metadata"]
        status = pod.get("status") or {}
        name = meta["name"]
        ready = sum(
            1 for c in (status.get("containerStatuses") or [])
            if c.get("ready")
        )
        total = len(status.get("containerStatuses") or [])
        ready_s = f"{ready}/{total}" if total else "?"
        phase = status.get("phase") or "?"
        restarts = sum(
            (c.get("restartCount") or 0) for c in (status.get("containerStatuses") or [])
        )
        print(
            f"{name:<42} {ready_s:<7} {phase:<11} {restarts:<9} "
            f"{gpu.get(name, '<unknown>'):<10} {age(meta.get('creationTimestamp'))}"
        )

# Load-test job pods (if running)
try:
    raw = subprocess.check_output(
        [
            "kubectl", "get", "pods", "-n", ns,
            "-l", "job-name=nemoclaw-gpu-hpa-load-test",
            "-o", "json",
        ],
        stderr=subprocess.DEVNULL,
        text=True,
    )
    load_items = json.loads(raw).get("items") or []
except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError):
    load_items = []

if load_items:
    print()
    print("Load-test generators:")
    print(f"{'NAME':<42} {'READY':<7} {'STATUS':<11} {'RESTARTS':<9} AGE")
    for pod in sorted(load_items, key=lambda p: p["metadata"]["name"]):
        meta = pod["metadata"]
        status = pod.get("status") or {}
        name = meta["name"]
        ready = sum(
            1 for c in (status.get("containerStatuses") or [])
            if c.get("ready")
        )
        total = len(status.get("containerStatuses") or [])
        ready_s = f"{ready}/{total}" if total else "?"
        phase = status.get("phase") or "?"
        restarts = sum(
            (c.get("restartCount") or 0) for c in (status.get("containerStatuses") or [])
        )
        print(
            f"{name:<42} {ready_s:<7} {phase:<11} {restarts:<9} "
            f"{age(meta.get('creationTimestamp'))}"
        )
PY
}

# Log one HPA row when TARGETS or REPLICAS change (load-test loops).
# Usage: hpa_common_log_hpa_if_changed <namespace> <last_line_var_name>
hpa_common_log_hpa_if_changed() {
  local ns="${1:?namespace}"
  local last_var="${2:?lastLineVar}"
  local line last
  line="$(hpa_common_format_hpa "${ns}" 0 "script" 2>/dev/null | head -1 || true)"
  [[ -z "${line}" ]] && return 0
  last="${!last_var}"
  if [[ "${line}" != "${last}" ]]; then
    hpa_common_log "${line}"
    printf -v "${last_var}" '%s' "${line}"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

# Match Helm fullname in templates/_helpers.tpl (release name contains chart name → use release only).
# Driven entirely by the RELEASE/CHART_NAME env vars; no caller passes positional args.
hpa_common_release_fullname() {
  local release="${RELEASE:-nemoclaw-gpu}"
  local chart="${CHART_NAME:-nemoclaw-gpu}"
  if [[ "${release}" == *"${chart}"* ]]; then
    echo "${release}"
  else
    echo "${release}-${chart}"
  fi
}

hpa_common_agent_deployment() {
  echo "$(hpa_common_release_fullname)-agent"
}

hpa_common_agent_service() {
  echo "$(hpa_common_release_fullname)-agent"
}

hpa_common_release_selector() {
  local release="${RELEASE:-nemoclaw-gpu}"
  local chart="${CHART_NAME:-nemoclaw-gpu}"
  printf 'app.kubernetes.io/name=%s,app.kubernetes.io/instance=%s' "${chart}" "${release}"
}

# Reject cleartext when Kubernetes reports a node or ingress-controller exposure path.
# The operator must separately restrict access from other hosts on the private network.
hpa_common_verify_insecure_ingress_isolation() {
  local ingress_ns="${INGRESS_NS:-ingress-nginx}"
  local ingress_release="${INGRESS_RELEASE:-ingress-nginx}"

  require_cmd kubectl
  require_cmd python3
  python3 - "${ingress_ns}" "${ingress_release}" <<'PY'
import ipaddress
import json
import subprocess
import sys

namespace, release = sys.argv[1:]


def kubectl_json(*args):
    try:
        raw = subprocess.check_output(
            ["kubectl", *args, "-o", "json"],
            stderr=subprocess.PIPE,
            text=True,
        )
        return json.loads(raw)
    except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError) as exc:
        print(f"cannot verify cleartext ingress isolation: kubectl {' '.join(args)} failed", file=sys.stderr)
        raise SystemExit(1) from exc


private_ranges = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "10.0.0.0/8",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)

nodes = kubectl_json("get", "nodes").get("items") or []
internal_ips = []
external_ips = []
for node in nodes:
    for address in (node.get("status") or {}).get("addresses") or []:
        if address.get("type") == "InternalIP":
            internal_ips.append(address.get("address", ""))
        elif address.get("type") == "ExternalIP":
            external_ips.append(address.get("address", ""))

if not internal_ips:
    print("cleartext ingress denied: cluster nodes have no verifiable InternalIP", file=sys.stderr)
    raise SystemExit(1)
if external_ips:
    print("cleartext ingress denied: cluster nodes expose ExternalIP addresses", file=sys.stderr)
    raise SystemExit(1)
for raw in internal_ips:
    try:
        address = ipaddress.ip_address(raw)
    except ValueError as exc:
        print(f"cleartext ingress denied: invalid node InternalIP {raw!r}", file=sys.stderr)
        raise SystemExit(1) from exc
    if not any(address in network for network in private_ranges):
        print(f"cleartext ingress denied: node InternalIP {raw} is not private", file=sys.stderr)
        raise SystemExit(1)

selector = (
    "app.kubernetes.io/component=controller,"
    f"app.kubernetes.io/instance={release}"
)
services = kubectl_json(
    "get", "services", "-n", namespace, "-l", selector
).get("items") or []
if not services:
    print("cleartext ingress denied: managed ingress controller Service not found", file=sys.stderr)
    raise SystemExit(1)

for service in services:
    name = (service.get("metadata") or {}).get("name", "<unknown>")
    spec = service.get("spec") or {}
    status = service.get("status") or {}
    if spec.get("type") != "ClusterIP":
        print(f"cleartext ingress denied: Service {name} is not ClusterIP", file=sys.stderr)
        raise SystemExit(1)
    if spec.get("externalIPs"):
        print(f"cleartext ingress denied: Service {name} has externalIPs", file=sys.stderr)
        raise SystemExit(1)
    if ((status.get("loadBalancer") or {}).get("ingress") or []):
        print(f"cleartext ingress denied: Service {name} has a load-balancer address", file=sys.stderr)
        raise SystemExit(1)

pods = kubectl_json(
    "get", "pods", "-n", namespace, "-l", selector
).get("items") or []
if not pods:
    print("cleartext ingress denied: managed ingress controller pods not found", file=sys.stderr)
    raise SystemExit(1)
for pod in pods:
    name = (pod.get("metadata") or {}).get("name", "<unknown>")
    spec = pod.get("spec") or {}
    if spec.get("hostNetwork"):
        print(f"cleartext ingress denied: pod {name} uses hostNetwork", file=sys.stderr)
        raise SystemExit(1)
    for container in spec.get("containers") or []:
        for port in container.get("ports") or []:
            if port.get("hostPort"):
                print(f"cleartext ingress denied: pod {name} uses hostPort", file=sys.stderr)
                raise SystemExit(1)
PY
}

hpa_common_ingress_allow_insecure_value() {
  case "${ALLOW_INSECURE_HTTP:-0}" in
    0)
      printf 'false'
      ;;
    1)
      if ! hpa_common_verify_insecure_ingress_isolation; then
        echo "Configure ingress.tls instead, or restrict the reported exposure path before retrying cleartext." >&2
        return 1
      fi
      printf 'true'
      ;;
    *)
      echo "ALLOW_INSECURE_HTTP must be 0 or 1" >&2
      return 1
      ;;
  esac
}

# Old releases used component=agent; chart now uses gpu-agent + workload-type (immutable selector).
hpa_common_gpu_stale_workload() {
  local ns="${1:?namespace}"
  local deploy="${2:?deploy}"
  local comp
  comp="$(kubectl get "deployment/${deploy}" -n "${ns}" \
    -o jsonpath='{.spec.selector.matchLabels.component}' 2>/dev/null || true)"
  [[ "${comp}" == "agent" ]]
}

hpa_common_gpu_recreate_stale_workload() {
  local ns="${1:?namespace}"
  local deploy="${2:?deploy}"
  local svc="${3:-${deploy}}"
  if hpa_common_gpu_stale_workload "${ns}" "${deploy}"; then
    kubectl delete "deployment/${deploy}" "service/${svc}" -n "${ns}" \
      --ignore-not-found --wait=false 2>/dev/null || true
    sleep 2
  fi
}

# Idle GPU HPA baseline (no --reuse-values — avoids Service port merge bugs).
hpa_common_gpu_helm_upgrade() {
  local release="${1:?release}"
  local chart_dir="${2:?chartDir}"
  local ns="${3:?namespace}"
  local hpa_values="${4:?valuesFile}"
  local min="${5:-1}"
  local max="${6:-4}"
  local gpu_target="${7:-40}"
  local inference_model="${8:-llama3.2:3b}"
  local ingress_host="${9:-}"

  local allow_insecure_http
  allow_insecure_http="$(hpa_common_ingress_allow_insecure_value)"

  local helm_args=(
    upgrade --install "${release}" "${chart_dir}"
    --namespace "${ns}"
    --create-namespace
    --set namespace.create=false
    -f "${hpa_values}"
    --set inference.model="${inference_model}"
    --set probes.readinessChecksInference=true
    --set autoscaling.enabled=true
    --set autoscaling.mode=gpu
    --set autoscaling.minReplicas="${min}"
    --set autoscaling.maxReplicas="${max}"
    --set "autoscaling.targetGPUUtilizationPercentage=${gpu_target}"
    --set "ingress.allowInsecureHttp=${allow_insecure_http}"
  )
  if [[ -n "${ingress_host}" ]]; then
    helm_args+=(--set "ingress.host=${ingress_host}")
  fi

  helm "${helm_args[@]}" >/dev/null
}

# Recovery touches only pods owned by this Helm release and the named load-test Job.
hpa_common_clear_stuck_pods() {
  local ns="${1:?namespace}"
  local job_name="${2:-nemoclaw-gpu-hpa-load-test}"
  local release_selector
  release_selector="$(hpa_common_release_selector)"
  local pod
  for pod in $(kubectl get pods -n "${ns}" \
    -l "${release_selector}" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    [[ -z "${pod}" ]] && continue
    kubectl patch pod "${pod}" -n "${ns}" -p '{"metadata":{"finalizers":null}}' --type=merge \
      >/dev/null 2>&1 || true
  done
  for pod in $(kubectl get pods -n "${ns}" \
    -l "job-name=${job_name}" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    [[ -z "${pod}" ]] && continue
    kubectl patch pod "${pod}" -n "${ns}" -p '{"metadata":{"finalizers":null}}' --type=merge \
      >/dev/null 2>&1 || true
  done
  kubectl delete pods -n "${ns}" -l "${release_selector}" \
    --force --grace-period=0 >/dev/null 2>&1 || true
  kubectl delete pods -n "${ns}" -l "job-name=${job_name}" \
    --force --grace-period=0 >/dev/null 2>&1 || true
}

hpa_common_ensure_agent_ready() {
  local ns="${1:?namespace}"
  local release="${2:?release}"
  local chart_dir="${3:?chartDir}"
  local values_file="${4:-}"
  local rollout_timeout="${5:-600}"
  local deploy
  deploy="$(RELEASE="${release}" hpa_common_agent_deployment)"

  local allow_insecure_http
  allow_insecure_http="$(hpa_common_ingress_allow_insecure_value)"

  local helm_args=(
    upgrade --install "${release}" "${chart_dir}" -n "${ns}"
    --set "namespace.create=false"
    --set "autoscaling.enabled=false"
    --set "gpuScaling.count=1"
    --set "ingress.allowInsecureHttp=${allow_insecure_http}"
  )
  if [[ -n "${values_file}" && -f "${values_file}" ]]; then
    helm_args+=(-f "${values_file}")
  fi
  helm "${helm_args[@]}" >/dev/null

  hpa_common_kick_deployment "${ns}" "${deploy}" || helm "${helm_args[@]}" >/dev/null

  if ! kubectl rollout status "deployment/${deploy}" -n "${ns}" --timeout="${rollout_timeout}s" >/dev/null; then
    hpa_common_diagnose_rollout "${ns}" "${deploy}"
    return 1
  fi

  local ready
  ready="$(kubectl get "deployment/${deploy}" -n "${ns}" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
  if [[ "${ready}" != "1" ]]; then
    hpa_common_diagnose_rollout "${ns}" "${deploy}"
    return 1
  fi
  return 0
}

hpa_common_wait_rollout() {
  local deploy="${1:?deploy}"
  local ns="${2:?namespace}"
  local timeout="${3:-600}"
  kubectl rollout status "deployment/${deploy}" -n "${ns}" --timeout="${timeout}s" >/dev/null
}

hpa_common_kick_deployment() {
  local ns="${1:?namespace}"
  local deploy="${2:?deploy}"
  local rs
  rs="$(kubectl get rs -n "${ns}" -l "app.kubernetes.io/name=nemoclaw-gpu,component=gpu-agent" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)"
  if [[ -n "${rs}" ]]; then
    return 0
  fi
  kubectl rollout restart "deployment/${deploy}" -n "${ns}" >/dev/null 2>&1 || true
  sleep 8
  rs="$(kubectl get rs -n "${ns}" -l "app.kubernetes.io/name=nemoclaw-gpu,component=gpu-agent" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [[ -n "${rs}" ]] && return 0
  kubectl delete "deployment/${deploy}" -n "${ns}" --ignore-not-found --wait=false 2>/dev/null || true
  sleep 3
  return 1
}

hpa_common_diagnose_rollout() {
  local ns="${1:?namespace}"
  hpa_common_print_hpa "${ns}"
  kubectl describe hpa -n "${ns}" 2>/dev/null | tail -20 || true
}

hpa_common_enforce_replica_floor() {
  local ns="${1:?namespace}"
  local deploy="${2:?deploy}"
  local min="${3:-1}"
  local spec
  spec="$(kubectl get "deployment/${deploy}" -n "${ns}" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "")"
  if [[ -z "${spec}" ]] || [[ "${spec}" -lt "${min}" ]]; then
    kubectl patch "deployment/${deploy}" -n "${ns}" \
      --type=merge -p "{\"spec\":{\"replicas\":${min}}}"
  fi
}

hpa_common_verify_hpa_bounds() {
  local ns="${1:?namespace}"
  local deploy="${2:?deploy}"
  local hpa_name="${3:-${deploy}}"
  local min="${4:-1}"
  local max="${5:-4}"

  if ! kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" >/dev/null 2>&1; then
    echo "HPA ${hpa_name} not found" >&2
    return 1
  fi

  local desired
  desired="$(kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" -o jsonpath='{.status.desiredReplicas}' 2>/dev/null || echo "")"

  hpa_common_enforce_replica_floor "${ns}" "${deploy}" "${min}"

  if [[ -n "${desired}" && "${desired}" =~ ^[0-9]+$ && "${desired}" -lt "${min}" ]]; then
    kubectl patch "deployment/${deploy}" -n "${ns}" \
      --type=merge -p "{\"spec\":{\"replicas\":${min}}}"
    sleep 5
  fi

  return 0
}

hpa_common_verify_gpu_nodes() {
  local gpu_count
  gpu_count="$(hpa_common_allocatable_gpus)"
  if [[ "${gpu_count}" -lt 1 ]]; then
    echo "No allocatable nvidia.com/gpu — HPA cannot scale GPU pods" >&2
    return 1
  fi
  return 0
}

hpa_common_allocatable_gpus() {
  kubectl get nodes -o jsonpath='{range .items[*]}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}' 2>/dev/null \
    | awk 'NF && $1+0>0 {s+=$1} END {print s+0}'
}

hpa_common_verify_gpu_hpa_metric() {
  local ns="${1:-${NAMESPACE:-nemoclaw-gpu}}"
  if kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/${ns}/pods/*/gpu_utilization_percent" 2>/dev/null \
    | grep -q '"metricName":"gpu_utilization_percent"'; then
    return 0
  fi
  echo "gpu_utilization_percent not available — HPA cannot scale on GPU util" >&2
  return 1
}

# Human-readable HPA metric (optional; VERBOSE=1 for full legend).
hpa_common_hpa_metric_display() {
  local ns="${1:?namespace}"
  local hpa_name="${2:-}"
  if [[ "${VERBOSE:-0}" != "1" ]]; then
    return 0
  fi
  if [[ -z "${hpa_name}" ]]; then
    hpa_name="$(kubectl get hpa -n "${ns}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  fi
  [[ -n "${hpa_name}" ]] || return 0

  local metric spec_target spec_type
  spec_type="$(kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" \
    -o jsonpath='{.spec.metrics[0].type}' 2>/dev/null || true)"
  if [[ "${spec_type}" == "Pods" ]]; then
    metric="$(kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" \
      -o jsonpath='{.spec.metrics[0].pods.metric.name}' 2>/dev/null || true)"
    spec_target="$(kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" \
      -o jsonpath='{.spec.metrics[0].pods.target.averageValue}' 2>/dev/null || true)"
  elif [[ "${spec_type}" == "Resource" ]]; then
    metric="$(kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" \
      -o jsonpath='{.spec.metrics[0].resource.name}' 2>/dev/null || true)"
    spec_target="$(kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" \
      -o jsonpath='{.spec.metrics[0].resource.target.averageUtilization}' 2>/dev/null || true)"
  fi
  echo "HPA metric: ${metric:-unknown} target=${spec_target:-?}"
}

# Default GPU HPA custom metric (prometheus-adapter → custom.metrics.k8s.io).
hpa_common_gpu_hpa_metric_name() {
  echo "gpu_utilization_percent"
}

hpa_common_print_hpa_status() {
  hpa_common_print_hpa "${1:?namespace}"
}
