#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Shared helpers for hpa-reset.sh and hpa-load-test.sh

hpa_common_log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

hpa_common_print_hpa() {
  local ns="${1:?namespace}"
  kubectl get hpa -n "${ns}" 2>/dev/null || true
}

hpa_common_log_hpa_if_changed() {
  local ns="${1:?namespace}"
  local last_var="${2:?lastLineVar}"
  local line last
  line="$(kubectl get hpa -n "${ns}" --no-headers 2>/dev/null | head -1 || true)"
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

# shellcheck disable=SC2034
hpa_common_agent_deployment() {
  echo "${RELEASE:-nemoclaw}-nemoclaw-cpu-agent"
}

hpa_common_clear_stuck_pods() {
  local ns="${1:?namespace}"
  local pod
  for pod in $(kubectl get pods -n "${ns}" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    [[ -z "${pod}" ]] && continue
    kubectl patch pod "${pod}" -n "${ns}" -p '{"metadata":{"finalizers":null}}' --type=merge \
      >/dev/null 2>&1 || true
  done
  kubectl delete pods -n "${ns}" --all --force --grace-period=0 >/dev/null 2>&1 || true
}

# Bring up one Ready agent before HPA (avoids desiredReplicas=0 / unknown metrics deadlock).
hpa_common_ensure_agent_ready() {
  local ns="${1:?namespace}"
  local release="${2:?release}"
  local chart_dir="${3:?chartDir}"
  local api_key="${4:?apiKey}"
  local values_file="${5:-}"
  local rollout_timeout="${6:-300}"
  local deploy
  deploy="$(RELEASE="${release}" hpa_common_agent_deployment)"

  local helm_args=(
    upgrade "${release}" "${chart_dir}" -n "${ns}"
    --reuse-values
    --set "namespace.create=false"
    --set "inference.apiKey=${api_key}"
    --set "autoscaling.enabled=false"
    --set "cpuScaling.count=1"
    --set "loadTest.cpuSpinMs=0"
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
  local timeout="${3:-300}"
  kubectl rollout status "deployment/${deploy}" -n "${ns}" --timeout="${timeout}s" >/dev/null
}

# If Deployment has no ReplicaSet (stuck controller), nudge or delete so helm can recreate.
hpa_common_kick_deployment() {
  local ns="${1:?namespace}"
  local deploy="${2:?deploy}"
  local rs
  rs="$(kubectl get rs -n "${ns}" -l "app.kubernetes.io/name=nemoclaw-cpu,component=cpu-agent" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)"
  if [[ -n "${rs}" ]]; then
    return 0
  fi
  kubectl rollout restart "deployment/${deploy}" -n "${ns}" >/dev/null 2>&1 || true
  sleep 8
  rs="$(kubectl get rs -n "${ns}" -l "app.kubernetes.io/name=nemoclaw-cpu,component=cpu-agent" \
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

# Never leave Deployment below minReplicas (HPA min is 1 — no scale-to-zero).
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

# After HPA is applied, ensure spec/status honor min..max (fix desiredReplicas=0 deadlock).
hpa_common_verify_hpa_bounds() {
  local ns="${1:?namespace}"
  local deploy="${2:?deploy}"
  local hpa_name="${3:-${deploy}}"
  local min="${4:-1}"
  local max="${5:-7}"

  if ! kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" >/dev/null 2>&1; then
    echo "HPA ${hpa_name} not found" >&2
    return 1
  fi

  local spec_min spec_max desired deploy_spec
  spec_min="$(kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" -o jsonpath='{.spec.minReplicas}' 2>/dev/null || echo 0)"
  spec_max="$(kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" -o jsonpath='{.spec.maxReplicas}' 2>/dev/null || echo 0)"
  desired="$(kubectl get "horizontalpodautoscaler/${hpa_name}" -n "${ns}" -o jsonpath='{.status.desiredReplicas}' 2>/dev/null || echo "")"
  deploy_spec="$(kubectl get "deployment/${deploy}" -n "${ns}" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "")"

  if [[ "${spec_min}" -lt "${min}" ]]; then
    echo "HPA spec.minReplicas=${spec_min} invalid" >&2
    return 1
  fi

  hpa_common_enforce_replica_floor "${ns}" "${deploy}" "${min}"

  if [[ -n "${desired}" && "${desired}" =~ ^[0-9]+$ && "${desired}" -lt "${min}" ]]; then
    kubectl patch "deployment/${deploy}" -n "${ns}" \
      --type=merge -p "{\"spec\":{\"replicas\":${min}}}"
    sleep 5
  fi

  return 0
}
