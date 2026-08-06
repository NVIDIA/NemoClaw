#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# One-shot HPA with readable metric-specific current/target values.
# GPU quantities render as percentages (30.25%/40%, not 30250m/40).
# For live updates prefer: kubectl get hpa -n nemoclaw-gpu -w
#
# Usage:
#   ./scripts/get-hpa.sh -n nemoclaw-gpu
#   ./scripts/get-hpa.sh -n nemoclaw-gpu -w    # same as kubectl get hpa -w

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
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

One-shot: formatted metric-specific current/target column.
GPU quantities render as percentages (30.25%/40%, not 30250m/40).

Live HPA (recommended):
  kubectl get hpa -n nemoclaw-gpu -w

Per-pod GPU breakdown (second terminal):
  ./scripts/get-agent-pods.sh -n nemoclaw-gpu -w

Examples:
  $(basename "$0") -n nemoclaw-gpu
  kubectl get hpa -n nemoclaw-gpu -w
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
  exec kubectl get hpa -n "${NAMESPACE}" -w
fi

hpa_common_print_hpa "${NAMESPACE}"
