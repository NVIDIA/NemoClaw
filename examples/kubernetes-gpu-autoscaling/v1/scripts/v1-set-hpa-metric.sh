#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Switch the GPU chart's HPA metric between gpu_utilization and latency_avg
# without touching the inference runtime, the sandboxes, or any other value.
# The v0 recipe does this inside agentscaling_hermes_{gpuutil,latency}.sh, which
# also create v0 sandboxes. A v1 deployment owns its own sandboxes, so this
# script only changes the chart's HPA.
#
# Usage:
#   ./scripts/v1-set-hpa-metric.sh gpu_utilization
#   ./scripts/v1-set-hpa-metric.sh latency_avg
#
# Env: NAMESPACE (nemoclaw-gpu), RELEASE (nemoclaw-gpu), GPU_TARGET (40),
# HPA_TARGET_LATENCY_MS (3000).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=../../scripts/hpa-common.sh
source "${CHART_DIR}/scripts/hpa-common.sh"
export PATH="${HOME}/.local/bin:${PATH}"

NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
RELEASE="${RELEASE:-nemoclaw-gpu}"
METRIC="${1:-}"
case "${METRIC}" in
  gpu_utilization | latency_avg) ;;
  *)
    echo "Usage: $0 gpu_utilization|latency_avg" >&2
    exit 2
    ;;
esac

helm_args=(
  upgrade "${RELEASE}" "${CHART_DIR}"
  --namespace "${NAMESPACE}"
  --reuse-values
  --set "autoscaling.metric=${METRIC}"
  --set "autoscaling.targetGPUUtilizationPercentage=${GPU_TARGET:-40}"
  --set "autoscaling.targetLatencyMilliseconds=${HPA_TARGET_LATENCY_MS:-3000}"
  --wait --timeout 10m
)
# Helm 4 needs --force-conflicts after kubectl patched the HPA. Helm 3 rejects it.
hpa_common_append_helm_force_conflicts helm_args || exit 1
helm "${helm_args[@]}" >/dev/null

hpa="$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_deployment)"
echo "HPA ${NAMESPACE}/${hpa} metric: $(kubectl get hpa "${hpa}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.metrics[0].pods.metric.name} target={.spec.metrics[0].pods.target.averageValue}')"
