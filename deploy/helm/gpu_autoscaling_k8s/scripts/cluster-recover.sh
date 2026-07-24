#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Recovery boundary: this script assumes NAMESPACE is dedicated to this chart (its own
# release plus the load-test Jobs scripts/hpa-load-test.sh creates in it) — it is the
# documented remedy for repeated rollout or namespace failures during install/load-test/
# reset. Deployment/ReplicaSet/HPA/Pod deletes are scoped to the chart's selector label
# (app.kubernetes.io/name=nemoclaw-gpu) or, for Pods, to job-name (Job-owned pods) so a
# namespace accidentally shared with unrelated workloads is not touched. Jobs are deleted
# with --all because no Job other than this chart's own load-test Jobs is expected to
# exist in a namespace dedicated to this chart; postcondition is that only chart-owned
# resources remain in NAMESPACE, verified by scripts/get-agent-pods.sh / get-hpa.sh after
# ./scripts/install-hpa.sh reinstalls (RUN_INSTALL=1, the default).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
RELEASE="${RELEASE:-nemoclaw-gpu}"
RESTART_MICROK8S="${RESTART_MICROK8S:-1}"
RUN_INSTALL="${RUN_INSTALL:-1}"

require_cmd kubectl
require_cmd helm

kubectl delete deploy,svc,hpa,rs -n "${NAMESPACE}" -l 'app.kubernetes.io/name=nemoclaw-gpu' --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete job -n "${NAMESPACE}" --all --ignore-not-found --wait=false 2>/dev/null || true
hpa_common_clear_stuck_pods "${NAMESPACE}"

helm uninstall "${RELEASE}" -n "${NAMESPACE}" 2>/dev/null || true
sleep 3

kubectl delete deploy,rs,hpa -n "${NAMESPACE}" -l 'app.kubernetes.io/name=nemoclaw-gpu' --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete job -n "${NAMESPACE}" --all --ignore-not-found --wait=false 2>/dev/null || true
hpa_common_clear_stuck_pods "${NAMESPACE}"

if [[ "${RESTART_MICROK8S}" == "1" ]] && command -v microk8s >/dev/null 2>&1; then
  microk8s stop
  microk8s start
  microk8s status --wait-ready
  microk8s enable gpu 2>/dev/null || true
fi

if [[ "${RUN_INSTALL}" == "1" ]]; then
  exec "${SCRIPT_DIR}/install-hpa.sh"
fi
