#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Static (no cluster required) Helm render test for the HPA/Deployment/Service/
# ServiceMonitor label-and-name contract this chart depends on at runtime:
#   - hpa.yaml's scaleTargetRef.name must match deployment.yaml's Deployment name.
#   - hpa.yaml must use only gpu_utilization_percent and its target must match
#     values.autoscaling.targetGPUUtilizationPercentage.
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

CLEARTEXT_RENDER_OUTPUT=""
if CLEARTEXT_RENDER_OUTPUT="$(helm template test-release "${CHART_DIR}" \
  -f "${CHART_DIR}/values-step2-hpa.yaml" \
  --set autoscaling.enabled=true 2>&1)"; then
  echo "FAIL: chart rendered a cleartext Ingress without explicit opt-in" >&2
  exit 1
fi
EXPECTED_TLS_POLICY_ERROR='ingress.tls is empty and ingress.allowInsecureHttp is false: refusing to render an Ingress that would expose /v1/chat/completions over plain HTTP. Configure ingress.tls with a real certificate, or set ALLOW_INSECURE_HTTP=1 when running the chart scripts to acknowledge cleartext HTTP after their exposure preflight. See README "Ingress security".'
if [[ "${CLEARTEXT_RENDER_OUTPUT}" != *"${EXPECTED_TLS_POLICY_ERROR}"* ]]; then
  echo "FAIL: cleartext Ingress render failed for an unexpected reason" >&2
  printf '%s\n' "${CLEARTEXT_RENDER_OUTPUT}" >&2
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
# A legacy non-GPU metric-name override must not alter the fixed HPA metric.
helm template test-release "${CHART_DIR}" -f "${CHART_DIR}/values-step2-hpa.yaml" \
  --set autoscaling.enabled=true \
  --set-string autoscaling.gpu.metricName=nemoclaw_http_inflight_requests \
  --set ollama.persistence.enabled=true \
  --set-string ollama.persistence.hostPath= \
  --set ollama.persistence.accessMode=ReadWriteMany \
  --set ollama.persistence.storageClass=test-rwx \
  --set ingress.allowInsecureHttp=true >"${RENDERED_FILE}"

python3 - "${RENDERED_FILE}" <<'PYEOF'
import json
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
config = get("ConfigMap")
hpa = get("HorizontalPodAutoscaler")
svc = get("Service")
svcmon = get("ServiceMonitor")
pvc = get("PersistentVolumeClaim")

if deploy:
    deploy_name = deploy["metadata"]["name"]
    pod_labels = deploy["spec"]["template"]["metadata"]["labels"]
    deploy_selector = deploy["spec"]["selector"]["matchLabels"]

    agent_containers = [
        c for c in deploy["spec"]["template"]["spec"]["containers"] if c.get("name") == "agent"
    ]
    if len(agent_containers) != 1:
        failures.append(f"expected exactly one agent container, found {len(agent_containers)}")
    elif agent_containers[0].get("command") != ["node", "/app/agent-server.ts"]:
        failures.append("agent container does not execute the mounted TypeScript entry point")

    app_volumes = [
        v for v in deploy["spec"]["template"]["spec"]["volumes"] if v.get("name") == "app"
    ]
    if len(app_volumes) != 1:
        failures.append(f"expected exactly one app volume, found {len(app_volumes)}")
    else:
        app_items = app_volumes[0].get("configMap", {}).get("items", [])
        package_items = [
            item
            for item in app_items
            if item.get("key") == "package.json" and item.get("path") == "package.json"
        ]
        if len(package_items) != 1:
            failures.append("app volume does not mount package.json next to agent-server.ts")

    if hpa:
        target_name = hpa["spec"]["scaleTargetRef"]["name"]
        if target_name != deploy_name:
            failures.append(
                f"HPA scaleTargetRef.name={target_name!r} != Deployment name={deploy_name!r}"
            )
        metrics = hpa["spec"]["metrics"]
        if len(metrics) != 1:
            failures.append(f"HPA must have exactly one GPU metric, found {len(metrics)}")
        elif metrics[0].get("type") != "Pods":
            failures.append(f"HPA metric type={metrics[0].get('type')!r}, expected 'Pods'")
        else:
            gpu_metric = metrics[0]["pods"]
            metric_name = gpu_metric["metric"]["name"]
            if metric_name != "gpu_utilization_percent":
                failures.append(
                    f"HPA Pods metric={metric_name!r}, expected 'gpu_utilization_percent'"
                )
            target_value = gpu_metric["target"]["averageValue"]
            if str(target_value) != "40":
                failures.append(
                    f"HPA gpu_utilization_percent averageValue={target_value!r}, expected 40 "
                    "(values-step2-hpa.yaml default targetGPUUtilizationPercentage)"
                )
        hpa_mode = hpa.get("metadata", {}).get("annotations", {}).get("nemoclaw.ai/hpa-mode")
        if hpa_mode != "gpu":
            failures.append(f"HPA mode annotation={hpa_mode!r}, expected 'gpu'")

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

if config:
    package_json = config.get("data", {}).get("package.json")
    try:
        package_metadata = json.loads(package_json or "")
    except json.JSONDecodeError:
        failures.append("agent ConfigMap package.json is not valid JSON")
    else:
        if package_metadata != {"type": "module"}:
            failures.append(
                f"agent ConfigMap package.json={package_metadata!r}, expected ESM metadata"
            )

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
