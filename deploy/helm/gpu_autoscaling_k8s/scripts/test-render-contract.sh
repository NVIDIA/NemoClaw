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

NOTES_FILE="${CHART_DIR}/templates/NOTES.txt"
if grep -q '\./scripts/' "${NOTES_FILE}"; then
  echo "FAIL: Helm NOTES contains a chart-directory-relative script command" >&2
  exit 1
fi
grep -Fq 'Pods: kubectl get pods' "${NOTES_FILE}" || {
  echo "FAIL: Helm NOTES does not provide a working-directory-independent pod command" >&2
  exit 1
}
grep -Fq 'Per-pod GPU metrics: kubectl get --raw' "${NOTES_FILE}" || {
  echo "FAIL: Helm NOTES does not provide the per-pod GPU metrics command" >&2
  exit 1
}

if helm template test-release "${CHART_DIR}" -f "${CHART_DIR}/values-step2-hpa.yaml" \
  --set autoscaling.enabled=true >/dev/null 2>&1; then
  echo "FAIL: chart rendered a cleartext Ingress without explicit opt-in" >&2
  exit 1
fi

TLS_RENDERED_FILE="$(mktemp)"
trap 'rm -f "${TLS_RENDERED_FILE}"' EXIT
helm template tls-policy-check "${CHART_DIR}" \
  -f "${CHART_DIR}/values-step2-hpa.yaml" \
  --set ingress.allowInsecureHttp=false \
  --set 'ingress.tls[0].secretName=test-tls' \
  --set 'ingress.tls[0].hosts[0]=nemoclaw.example.com' \
  --set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/ssl-redirect=false' \
  >"${TLS_RENDERED_FILE}"

python3 - "${TLS_RENDERED_FILE}" <<'PYEOF'
import sys
import yaml

with open(sys.argv[1]) as f:
    ingresses = [doc for doc in yaml.safe_load_all(f) if doc and doc.get("kind") == "Ingress"]

if len(ingresses) != 1:
    print(f"FAIL: expected exactly one TLS Ingress, found {len(ingresses)}", file=sys.stderr)
    sys.exit(1)

annotations = ingresses[0].get("metadata", {}).get("annotations", {})
if annotations.get("nginx.ingress.kubernetes.io/ssl-redirect") != "true":
    print("FAIL: TLS Ingress does not enforce ssl-redirect=true", file=sys.stderr)
    sys.exit(1)
PYEOF

assert_persistence_render_rejected() {
  local expected_message="${1:?expected message}"
  shift
  local output
  if output="$(helm template persistence-policy-check "${CHART_DIR}" \
    -f "${CHART_DIR}/values-step2-hpa.yaml" \
    --set ingress.allowInsecureHttp=true \
    --set ollama.persistence.enabled=true \
    --set-string ollama.persistence.hostPath= \
    "$@" 2>&1)"; then
    echo "FAIL: chart rendered an unsafe shared persistence configuration" >&2
    exit 1
  fi
  if [[ "${output}" != *"${expected_message}"* ]]; then
    echo "FAIL: persistence validation returned an unexpected error" >&2
    printf '%s\n' "${output}" >&2
    exit 1
  fi
}

assert_persistence_render_rejected \
  "ollama.persistence.accessMode must be ReadWriteMany" \
  --set ollama.persistence.accessMode=ReadWriteOnce \
  --set ollama.persistence.storageClass=test-rwx
assert_persistence_render_rejected \
  "ollama.persistence.storageClass is required" \
  --set ollama.persistence.accessMode=ReadWriteMany

if ! helm template hostpath-policy-check "${CHART_DIR}" \
  -f "${CHART_DIR}/values-step2-hpa.yaml" \
  --set ingress.allowInsecureHttp=true \
  --set ollama.persistence.enabled=true \
  --set ollama.persistence.accessMode=ReadWriteOnce \
  --set-string ollama.persistence.storageClass= \
  >/dev/null; then
  echo "FAIL: chart rejected the explicit single-node hostPath persistence mode" >&2
  exit 1
fi

RENDERED_FILE="$(mktemp)"
trap 'rm -f "${TLS_RENDERED_FILE}" "${RENDERED_FILE}"' EXIT
helm template test-release "${CHART_DIR}" -f "${CHART_DIR}/values-step2-hpa.yaml" \
  --set autoscaling.enabled=true \
  --set ollama.persistence.enabled=true \
  --set-string ollama.persistence.hostPath= \
  --set ollama.persistence.accessMode=ReadWriteMany \
  --set ollama.persistence.storageClass=test-rwx \
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
pvc = get("PersistentVolumeClaim")

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

    if pvc:
        pvc_name = pvc["metadata"]["name"]
        volumes = deploy["spec"]["template"]["spec"]["volumes"]
        ollama_volumes = [v for v in volumes if v.get("name") == "ollama-data"]
        if len(ollama_volumes) != 1:
            failures.append(
                f"expected exactly one ollama-data volume, found {len(ollama_volumes)}"
            )
        elif ollama_volumes[0].get("persistentVolumeClaim", {}).get("claimName") != pvc_name:
            failures.append("Deployment ollama-data volume does not reference the rendered PVC")

if pvc:
    if pvc["spec"].get("accessModes") != ["ReadWriteMany"]:
        failures.append("Ollama PVC does not request ReadWriteMany access")
    if pvc["spec"].get("storageClassName") != "test-rwx":
        failures.append("Ollama PVC does not use the configured storage class")

if failures:
    print("FAIL: render contract violations:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)

print("OK: HPA/Deployment/Service/ServiceMonitor render contract holds")
PYEOF

echo "OK: chart rejects cleartext Ingress without explicit opt-in"
echo "OK: Helm NOTES commands do not depend on the chart source directory"
echo "OK: chart enforces ssl-redirect=true when TLS is configured"
echo "OK: chart requires an explicit ReadWriteMany storage class for shared PVC persistence"
echo "OK: chart preserves the explicit single-node hostPath persistence mode"
