#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# One-shot or live GPU HPA with readable percentage current/target values
# (30.25%/40%, not Kubernetes Quantity milli-units such as 30250m/40).
#
# Usage:
#   ./scripts/get-hpa.sh -n nemoclaw-gpu
#   ./scripts/get-hpa.sh -n nemoclaw-gpu -w
#   HPA_WATCH_INTERVAL_SEC=5 ./scripts/get-hpa.sh -w

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

One-shot or live watch with a normalized GPU utilization column
(30.25%/40%, not kubectl's 30250m/40 Quantity form).

  HPA_WATCH_INTERVAL_SEC   poll interval for -w (default 2)

Raw kubectl stream (unnormalized):
  kubectl get hpa -n nemoclaw-gpu -w

Per-pod GPU breakdown (second terminal):
  ./scripts/get-metrics-proxy-pods.sh -n nemoclaw-gpu -w

Examples:
  $(basename "$0") -n nemoclaw-gpu
  $(basename "$0") -n nemoclaw-gpu -w
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
  hpa_common_watch_hpa "${NAMESPACE}"
  exit 0
fi

hpa_common_print_hpa "${NAMESPACE}"
