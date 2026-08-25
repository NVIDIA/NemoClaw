#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_MONITOR_TEMPLATE="${SCRIPT_DIR}/../monitoring/dcgm-servicemonitor.yaml"
RENDERED_FILE="$(mktemp)"
trap 'rm -f "${RENDERED_FILE}"' EXIT

for dcgm_namespace in gpu-operator-resources gpu-operator; do
  for prom_release in kube-prometheus kube-prometheus-stack; do
    sed -e "s|__DCGM_NAMESPACE__|${dcgm_namespace}|g" \
      -e "s|__PROM_RELEASE__|${prom_release}|g" \
      "${SERVICE_MONITOR_TEMPLATE}" >"${RENDERED_FILE}"
    python3 - "${RENDERED_FILE}" "${dcgm_namespace}" "${prom_release}" <<'PYEOF'
import sys

import yaml

with open(sys.argv[1]) as file:
    service_monitor = yaml.safe_load(file)

namespace = sys.argv[2]
release = sys.argv[3]
if service_monitor["metadata"]["namespace"] != namespace:
    raise SystemExit("ServiceMonitor metadata namespace did not match DCGM_NAMESPACE")
if service_monitor["spec"]["namespaceSelector"]["matchNames"] != [namespace]:
    raise SystemExit("ServiceMonitor namespace selector did not match DCGM_NAMESPACE")
if service_monitor["metadata"]["labels"]["release"] != release:
    raise SystemExit("ServiceMonitor release label did not match PROM_RELEASE")
PYEOF
  done
done

echo "OK: DCGM ServiceMonitor follows DCGM_NAMESPACE and PROM_RELEASE"
