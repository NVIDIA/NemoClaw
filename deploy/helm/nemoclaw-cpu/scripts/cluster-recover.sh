#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Full recovery when install-hpa / hpa-reset keep failing (stuck Deployment, ghost HPA).
#
# Usage:
#   cd deploy/helm/nemoclaw-cpu
#   source ~/.nemoclaw/secrets.env
#   ./scripts/cluster-recover.sh
#
# Env:
#   RESTART_MICROK8S=1   # run microk8s stop && start before reinstall (default 1)
#   RUN_INSTALL=1        # run install-hpa.sh after cleanup (default 1)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

NAMESPACE="${NAMESPACE:-nemoclaw}"
RELEASE="${RELEASE:-nemoclaw}"
RESTART_MICROK8S="${RESTART_MICROK8S:-1}"
RUN_INSTALL="${RUN_INSTALL:-1}"

require_cmd kubectl
require_cmd helm

if [[ -f "${HOME}/.nemoclaw/secrets.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${HOME}/.nemoclaw/secrets.env"
  set +a
fi

hpa_common_log "=== cluster recover (namespace=${NAMESPACE}) ==="

hpa_common_log "Remove stray test resources"
kubectl delete deploy,svc,hpa -n "${NAMESPACE}" -l 'app.kubernetes.io/name=nemoclaw-cpu' --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete deploy,svc t-nemoclaw-cpu-agent -n "${NAMESPACE}" --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete hpa -n "${NAMESPACE}" --all --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete job -n "${NAMESPACE}" --all --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete pods -n "${NAMESPACE}" --all --force --grace-period=0 2>/dev/null || true
hpa_common_clear_stuck_pods "${NAMESPACE}"

hpa_common_log "Uninstall Helm release ${RELEASE}"
helm uninstall "${RELEASE}" -n "${NAMESPACE}" 2>/dev/null || true
sleep 3

kubectl delete deploy,rs,hpa,job -n "${NAMESPACE}" --all --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete pods -n "${NAMESPACE}" --all --force --grace-period=0 2>/dev/null || true
hpa_common_clear_stuck_pods "${NAMESPACE}"

if [[ "${RESTART_MICROK8S}" == "1" ]] && command -v microk8s >/dev/null 2>&1; then
  hpa_common_log "Restart MicroK8s (fixes stuck deployment controller)"
  microk8s stop
  microk8s start
  microk8s status --wait-ready
fi

if [[ "${RUN_INSTALL}" == "1" ]]; then
  hpa_common_log "Reinstall via install-hpa.sh"
  exec "${SCRIPT_DIR}/install-hpa.sh"
fi

hpa_common_log "Done. Run: ./scripts/install-hpa.sh"
