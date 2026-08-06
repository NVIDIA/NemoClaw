#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Static (no cluster required) Helm render test for the HPA/Deployment/Service/
# ServiceMonitor label-and-name contract this chart depends on at runtime:
#   - hpa.yaml's scaleTargetRef.name must match deployment.yaml's Deployment name.
#   - hpa.yaml's gpu metric name/target must match values.autoscaling.gpu.metricName
#     and .targetGPUUtilizationPercentage.
#   - service.yaml's selector and servicemonitor.yaml's selector must both match
#     deployment.yaml's pod template labels — otherwise the Service has no
#     endpoints, or Prometheus scrapes nothing, while the chart still renders
#     valid YAML (the kind of silent breakage a template-only change can cause).
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/test-render-contract.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}
require_cmd helm
require_cmd python3
python3 -c 'import yaml' 2>/dev/null || {
  echo "missing Python dependency: PyYAML" >&2
  exit 1
}

if helm template test-release "${CHART_DIR}" -f "${CHART_DIR}/values-step2-hpa.yaml" \
  --set autoscaling.enabled=true >/dev/null 2>&1; then
  echo "FAIL: chart rendered a cleartext Ingress without explicit opt-in" >&2
  exit 1
fi

RENDERED_FILE="$(mktemp)"
trap 'rm -f "${RENDERED_FILE}"' EXIT
helm template test-release "${CHART_DIR}" -f "${CHART_DIR}/values-step2-hpa.yaml" \
  --set autoscaling.enabled=true \
  --set ingress.allowInsecureHttp=true >"${RENDERED_FILE}"

python3 - "${RENDERED_FILE}" <<'PYEOF'
import sys
import yaml

with open(sys.argv[1]) as f:
    docs = [d for d in yaml.safe_load_all(f) if d]
by_kind = {}
for d in docs:
    by_kind.setdefault(d.get("kind"), []).append(d)

failures = []


def get(kind):
    items = by_kind.get(kind, [])
    if len(items) != 1:
        failures.append(f"expected exactly one {kind}, found {len(items)}")
        return None
    return items[0]


deploy = get("Deployment")
hpa = get("HorizontalPodAutoscaler")
svc = get("Service")
svcmon = get("ServiceMonitor")

if deploy:
    deploy_name = deploy["metadata"]["name"]
    pod_labels = deploy["spec"]["template"]["metadata"]["labels"]
    deploy_selector = deploy["spec"]["selector"]["matchLabels"]

    if hpa:
        target_name = hpa["spec"]["scaleTargetRef"]["name"]
        if target_name != deploy_name:
            failures.append(
                f"HPA scaleTargetRef.name={target_name!r} != Deployment name={deploy_name!r}"
            )
        metrics = hpa["spec"]["metrics"]
        gpu_metrics = [
            m for m in metrics if m.get("type") == "Pods" and m["pods"]["metric"]["name"] == "gpu_utilization_percent"
        ]
        if not gpu_metrics:
            failures.append("HPA has no gpu_utilization_percent Pods metric (autoscaling.mode=gpu)")
        else:
            target_value = gpu_metrics[0]["pods"]["target"]["averageValue"]
            if str(target_value) != "40":
                failures.append(
                    f"HPA gpu_utilization_percent averageValue={target_value!r}, expected 40 "
                    "(values-step2-hpa.yaml default targetGPUUtilizationPercentage)"
                )

    for kind, obj in (("Service", svc), ("ServiceMonitor", svcmon)):
        if not obj:
            continue
        selector = obj["spec"]["selector"]
        selector = selector.get("matchLabels", selector) if kind == "ServiceMonitor" else selector
        for k, v in selector.items():
            if pod_labels.get(k) != v:
                failures.append(
                    f"{kind} selector {k}={v!r} does not match Deployment pod label {k}={pod_labels.get(k)!r}"
                )

if failures:
    print("FAIL: render contract violations:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)

print("OK: HPA/Deployment/Service/ServiceMonitor render contract holds")
PYEOF

echo "OK: chart rejects cleartext Ingress without explicit opt-in"
