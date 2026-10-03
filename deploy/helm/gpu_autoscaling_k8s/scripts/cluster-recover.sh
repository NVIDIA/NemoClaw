#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Kubernetes deletions target only this Helm release and the configured load-test Job.
# RESTART_MICROK8S=1 is a separate, cluster-wide interruption.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
RELEASE="${RELEASE:-nemoclaw-gpu}"
JOB_NAME="${JOB_NAME:-nemoclaw-gpu-hpa-load-test}"
RESTART_MICROK8S="${RESTART_MICROK8S:-0}"
RUN_INSTALL="${RUN_INSTALL:-1}"

require_cmd kubectl
require_cmd helm

RELEASE_SELECTOR="$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_release_selector)"

kubectl delete deploy,svc,hpa,rs -n "${NAMESPACE}" -l "${RELEASE_SELECTOR}" --ignore-not-found
kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found
hpa_common_clear_stuck_pods "${NAMESPACE}" "${JOB_NAME}"

helm uninstall "${RELEASE}" -n "${NAMESPACE}" 2>/dev/null || true
sleep 3

kubectl delete deploy,svc,hpa,rs -n "${NAMESPACE}" -l "${RELEASE_SELECTOR}" --ignore-not-found
kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found
hpa_common_clear_stuck_pods "${NAMESPACE}" "${JOB_NAME}"

if [[ "${RESTART_MICROK8S}" == "1" ]] && command -v microk8s >/dev/null 2>&1; then
  echo "RESTART_MICROK8S=1 stops every workload in this MicroK8s cluster." >&2
  microk8s stop
  microk8s start
  microk8s status --wait-ready
  microk8s enable gpu 2>/dev/null || true
fi

if [[ "${RUN_INSTALL}" == "1" ]]; then
  exec "${SCRIPT_DIR}/install-hpa.sh"
fi
