#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Per-pod GPU agent status (READY, GPU UTIL %, load-test generators).
# Use alongside: kubectl get hpa -n nemoclaw-gpu -w
#
# Usage:
#   ./scripts/get-agent-pods.sh -n nemoclaw-gpu
#   ./scripts/get-agent-pods.sh -n nemoclaw-gpu -w

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
INTERVAL="${INTERVAL:-5}"
WATCH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n | --namespace)
      NAMESPACE="${2:?namespace required after -n}"
      shift 2
      ;;
    -w | --watch)
      WATCH=1
      shift
      ;;
    -h | --help)
      cat <<EOF
Usage: $(basename "$0") [-n NAMESPACE] [-w]

Agent pods with per-pod GPU utilization (not HPA average).

Watch HPA in another terminal:
  kubectl get hpa -n nemoclaw-gpu -w

Examples:
  $(basename "$0") -n nemoclaw-gpu
  $(basename "$0") -n nemoclaw-gpu -w

Env: INTERVAL (watch refresh seconds, default 5)
EOF
      exit 0
      ;;
    *)
      echo "unknown argument: $1 (try --help)" >&2
      exit 1
      ;;
  esac
done

require_cmd kubectl

if [[ "${WATCH}" -eq 1 ]]; then
  while true; do
    clear 2>/dev/null || true
    hpa_common_print_agent_pods "${NAMESPACE}"
    sleep "${INTERVAL}"
  done
fi

hpa_common_print_agent_pods "${NAMESPACE}"
