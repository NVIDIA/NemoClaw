#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Static (no cluster required) Helm render test for the HPA/Deployment/Service/
# ServiceMonitor label-and-name contract this chart depends on at runtime:
#   - hpa.yaml's scaleTargetRef.name must match deployment.yaml's Deployment name.
#   - hpa.yaml defaults to gpu_utilization_percent (GPU utilization HPA example).
#     Target must match values.autoscaling.targetGPUUtilizationPercentage.
#   - autoscaling.metric=latency_avg must render the matching custom metric.
#   - autoscaling.metric values other than gpu_utilization|latency_avg must fail to render.
#   - A legacy autoscaling.gpu.metricName override must not change the selected metric.
#   - service.yaml's selector and servicemonitor.yaml's selector must both match
#     deployment.yaml's pod template labels — otherwise the Service has no
#     endpoints, or Prometheus scrapes nothing, while the chart still renders
#     valid YAML (the kind of silent breakage a template-only change can cause).
#
# Usage:
#   cd examples/recipes/nvidia/kubernetes-gpu-autoscaling
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

# Envoy Gateway basic auth requires Apache {SHA} htpasswd. Use a fixed test credential
# for every local helm template invocation so the chart can render without a cluster.
AUTH_PASSWORD='test-password'
AUTH_HTPASSWD='admin:{SHA}eJy+BAeECxwgQcszRS/2Dxm/WMw='
AUTH_HELM_SETS=(
  --set "ingress.auth.password=${AUTH_PASSWORD}"
  --set-string "ingress.auth.htpasswd=${AUTH_HTPASSWD}"
)

python3 - "${CHART_DIR}/values.yaml" <<'PYEOF'
import sys
import yaml

with open(sys.argv[1]) as f:
    values = yaml.safe_load(f)

auth = (values.get("inference") or {}).get("auth") or {}
if auth.get("enabled") is not True:
    print("FAIL: in-cluster inference authentication is not enabled by default", file=sys.stderr)
    sys.exit(1)
if "apiKey" in auth:
    print("FAIL: values.yaml must not expose an inference API key field", file=sys.stderr)
    sys.exit(1)
if auth.get("key") != "api-key":
    print("FAIL: inference Secret key contract changed", file=sys.stderr)
    sys.exit(1)
PYEOF

AUTH_DISABLED_OUTPUT=""
if AUTH_DISABLED_OUTPUT="$(helm template auth-policy-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  --set ingress.allowInsecureHttp=true \
  --set inference.auth.enabled=false 2>&1)"; then
  echo "FAIL: chart rendered with in-cluster inference authentication disabled" >&2
  exit 1
fi
if [[ "${AUTH_DISABLED_OUTPUT}" != *"inference.auth.enabled must remain true"* ]]; then
  echo "FAIL: disabled inference authentication failed for an unexpected reason" >&2
  printf '%s\n' "${AUTH_DISABLED_OUTPUT}" >&2
  exit 1
fi

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
grep -Fq 'Inference API key: kubectl get secret' "${NOTES_FILE}" || {
  echo "FAIL: Helm NOTES does not document the inference API key command" >&2
  exit 1
}
grep -Fq 'replace "." "\\." .Values.inference.auth.key' "${NOTES_FILE}" || {
  echo "FAIL: Helm NOTES does not escape dotted inference Secret keys for JSONPath" >&2
  exit 1
}

CLEARTEXT_RENDER_OUTPUT=""
if CLEARTEXT_RENDER_OUTPUT="$(helm template test-release "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  -f "${CHART_DIR}/values.yaml" \
  --set autoscaling.enabled=true 2>&1)"; then
  echo "FAIL: chart rendered a cleartext Gateway without explicit opt-in" >&2
  exit 1
fi
EXPECTED_TLS_POLICY_ERROR='ingress.tls is empty and ingress.allowInsecureHttp is false: refusing to render a Gateway that would expose /v1/chat/completions over plain HTTP. Configure ingress.tls with a real certificate, or set ALLOW_INSECURE_HTTP=1 when running the chart scripts to acknowledge cleartext HTTP after their exposure preflight. See README "Ingress security".'
if [[ "${CLEARTEXT_RENDER_OUTPUT}" != *"${EXPECTED_TLS_POLICY_ERROR}"* ]]; then
  echo "FAIL: cleartext Gateway render failed for an unexpected reason" >&2
  printf '%s\n' "${CLEARTEXT_RENDER_OUTPUT}" >&2
  exit 1
fi

# With Envoy LB disabled, the chart must render without TLS / Gateway objects.
LB_OFF_RENDERED_FILE="$(mktemp)"
helm template lb-off-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  -f "${CHART_DIR}/values.yaml" \
  --set autoscaling.enabled=true \
  --set ingress.gateway.enabled=false \
  >"${LB_OFF_RENDERED_FILE}"
python3 - "${LB_OFF_RENDERED_FILE}" <<'PYEOF'
import sys
import yaml

docs = [doc for doc in yaml.safe_load_all(open(sys.argv[1])) if doc]
kinds = {(doc.get("kind"), (doc.get("metadata") or {}).get("name")) for doc in docs}
forbidden = [k for k in ("Gateway", "HTTPRoute", "BackendTrafficPolicy", "SecurityPolicy", "EnvoyProxy") if any(kind == k for kind, _ in kinds)]
if forbidden:
    print(f"FAIL: ingress.gateway.enabled=false still rendered {forbidden}", file=sys.stderr)
    sys.exit(1)
if any(kind == "Secret" and name and name.endswith("-ingress-auth") for kind, name in kinds):
    print("FAIL: ingress auth Secret rendered while Envoy LB is disabled", file=sys.stderr)
    sys.exit(1)
print("OK: Envoy LB-off render omits Gateway API objects")
PYEOF
rm -f "${LB_OFF_RENDERED_FILE}"

# OpenShell cleartext HTTP listener must not be paired with NodePort/LoadBalancer.
EXPECTED_EXPOSURE_ERROR='ingress.gateway.serviceType must be ClusterIP while the OpenShell cleartext HTTP listener is present'
for bad_type in NodePort LoadBalancer; do
  EXPOSURE_RENDER_OUTPUT=""
  if EXPOSURE_RENDER_OUTPUT="$(helm template exposure-policy-check "${CHART_DIR}" \
    "${AUTH_HELM_SETS[@]}" \
    -f "${CHART_DIR}/values.yaml" \
    --set autoscaling.enabled=true \
    --set ingress.allowInsecureHttp=true \
    --set "ingress.gateway.serviceType=${bad_type}" 2>&1)"; then
    echo "FAIL: chart rendered OpenShell cleartext HTTP with ingress.gateway.serviceType=${bad_type}" >&2
    exit 1
  fi
  if [[ "${EXPOSURE_RENDER_OUTPUT}" != *"${EXPECTED_EXPOSURE_ERROR}"* ]]; then
    echo "FAIL: ${bad_type} Gateway exposure failed for an unexpected reason" >&2
    printf '%s\n' "${EXPOSURE_RENDER_OUTPUT}" >&2
    exit 1
  fi
done
# Same boundary with TLS configured: external HTTPS must not unlock NodePort/LoadBalancer
# while the hostname-unrestricted OpenShell HTTP listener remains on the same Gateway.
if EXPOSURE_RENDER_OUTPUT="$(helm template exposure-tls-policy-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  -f "${CHART_DIR}/values.yaml" \
  --set autoscaling.enabled=true \
  --set ingress.allowInsecureHttp=false \
  --set ingress.tls[0].secretName=nemoclaw-example-tls \
  --set ingress.tls[0].hosts[0]=nemoclaw.example.com \
  --set ingress.gateway.serviceType=LoadBalancer 2>&1)"; then
  echo "FAIL: chart rendered OpenShell cleartext HTTP with TLS + LoadBalancer" >&2
  exit 1
fi
if [[ "${EXPOSURE_RENDER_OUTPUT}" != *"${EXPECTED_EXPOSURE_ERROR}"* ]]; then
  echo "FAIL: TLS + LoadBalancer exposure failed for an unexpected reason" >&2
  printf '%s\n' "${EXPOSURE_RENDER_OUTPUT}" >&2
  exit 1
fi
echo "OK: chart rejects NodePort/LoadBalancer while OpenShell cleartext HTTP listener is present"

# ingress.pathType must be Prefix or Exact — never silently coerce other values.
PATHTYPE_ERROR='ingress.pathType'
for bad_path_type in ImplementationSpecific Invalid Foo; do
  PATHTYPE_RENDER_OUTPUT=""
  if PATHTYPE_RENDER_OUTPUT="$(helm template pathtype-policy-check "${CHART_DIR}" \
    "${AUTH_HELM_SETS[@]}" \
    -f "${CHART_DIR}/values.yaml" \
    --set autoscaling.enabled=true \
    --set ingress.allowInsecureHttp=true \
    --set-string "ingress.pathType=${bad_path_type}" 2>&1)"; then
    echo "FAIL: chart rendered with unsupported ingress.pathType=${bad_path_type}" >&2
    exit 1
  fi
  if [[ "${PATHTYPE_RENDER_OUTPUT}" != *"${PATHTYPE_ERROR}"* ]] \
    || [[ "${PATHTYPE_RENDER_OUTPUT}" != *"Prefix or Exact"* ]]; then
    echo "FAIL: unsupported pathType=${bad_path_type} failed for an unexpected reason" >&2
    printf '%s\n' "${PATHTYPE_RENDER_OUTPUT}" >&2
    exit 1
  fi
done
echo "OK: chart rejects unsupported ingress.pathType values"

TLS_RENDERED_FILE="$(mktemp)"
trap 'rm -f "${TLS_RENDERED_FILE}"' EXIT
helm template tls-policy-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  -f "${CHART_DIR}/values.yaml" \
  --set ingress.allowInsecureHttp=false \
  --set 'ingress.tls[0].secretName=test-tls' \
  --set 'ingress.tls[0].hosts[0]=nemoclaw.example.com' \
  >"${TLS_RENDERED_FILE}"

python3 - "${TLS_RENDERED_FILE}" <<'PYEOF'
import sys
import yaml

with open(sys.argv[1]) as f:
    docs = [doc for doc in yaml.safe_load_all(f) if doc]

gateways = [doc for doc in docs if doc.get("kind") == "Gateway"]
routes = [doc for doc in docs if doc.get("kind") == "HTTPRoute"]
policies = [doc for doc in docs if doc.get("kind") == "BackendTrafficPolicy"]
security = [doc for doc in docs if doc.get("kind") == "SecurityPolicy"]
proxies = [doc for doc in docs if doc.get("kind") == "EnvoyProxy"]

if len(gateways) != 1:
    print(f"FAIL: expected exactly one Gateway, found {len(gateways)}", file=sys.stderr)
    sys.exit(1)
if len(proxies) != 1:
    print(f"FAIL: expected exactly one EnvoyProxy, found {len(proxies)}", file=sys.stderr)
    sys.exit(1)
if proxies[0]["spec"]["provider"]["kubernetes"]["envoyService"]["type"] != "ClusterIP":
    print("FAIL: EnvoyProxy dataplane Service type is not ClusterIP", file=sys.stderr)
    sys.exit(1)

listener_names = {listener["name"] for listener in gateways[0]["spec"]["listeners"]}
if listener_names != {"http", "https"}:
    print(f"FAIL: Gateway listeners={listener_names!r}, expected http+https", file=sys.stderr)
    sys.exit(1)

redirect = [
    route
    for route in routes
    if any(
        filter.get("type") == "RequestRedirect"
        for rule in route.get("spec", {}).get("rules", [])
        for filter in rule.get("filters", [])
    )
]
if len(redirect) != 1:
    print(f"FAIL: expected exactly one HTTPS redirect HTTPRoute, found {len(redirect)}", file=sys.stderr)
    sys.exit(1)
if redirect[0]["spec"]["parentRefs"][0].get("sectionName") != "http":
    print("FAIL: HTTPS redirect HTTPRoute is not attached to the http listener", file=sys.stderr)
    sys.exit(1)

inference_routes = [route for route in routes if route not in redirect]
if len(inference_routes) != 2:
    print(
        f"FAIL: expected OpenShell + external inference HTTPRoutes, found {len(inference_routes)}",
        file=sys.stderr,
    )
    sys.exit(1)

openshell_routes = [
    route
    for route in inference_routes
    if route.get("metadata", {}).get("labels", {}).get("nemoclaw.ai/route-role") == "openshell"
]
external_routes = [
    route
    for route in inference_routes
    if route.get("metadata", {}).get("labels", {}).get("nemoclaw.ai/route-role") == "external"
]
if len(openshell_routes) != 1 or len(external_routes) != 1:
    print("FAIL: expected one openshell and one external HTTPRoute", file=sys.stderr)
    sys.exit(1)
if openshell_routes[0]["spec"]["parentRefs"][0].get("sectionName") != "http":
    print("FAIL: OpenShell HTTPRoute is not attached to the http listener", file=sys.stderr)
    sys.exit(1)
if openshell_routes[0]["spec"].get("hostnames"):
    print("FAIL: OpenShell HTTPRoute must remain hostname-unrestricted", file=sys.stderr)
    sys.exit(1)
if external_routes[0]["spec"]["parentRefs"][0].get("sectionName") != "https":
    print("FAIL: external HTTPRoute is not attached to the https listener", file=sys.stderr)
    sys.exit(1)

http_listeners = [
    listener
    for listener in gateways[0]["spec"]["listeners"]
    if listener.get("name") == "http"
]
if len(http_listeners) != 1 or http_listeners[0].get("hostname"):
    print("FAIL: http listener must stay hostname-unrestricted for OpenShell", file=sys.stderr)
    sys.exit(1)

if len(policies) != 2:
    print(f"FAIL: expected two BackendTrafficPolicies, found {len(policies)}", file=sys.stderr)
    sys.exit(1)
policy_targets = {policy["spec"]["targetRefs"][0]["name"] for policy in policies}
expected_targets = {
    openshell_routes[0]["metadata"]["name"],
    external_routes[0]["metadata"]["name"],
}
if policy_targets != expected_targets:
    print(
        f"FAIL: BackendTrafficPolicy targets={policy_targets!r}, expected {expected_targets!r}",
        file=sys.stderr,
    )
    sys.exit(1)
if any(policy["spec"].get("loadBalancer", {}).get("type") != "LeastRequest" for policy in policies):
    print("FAIL: BackendTrafficPolicy does not pin LeastRequest on both routes", file=sys.stderr)
    sys.exit(1)

if len(security) != 1:
    print(f"FAIL: expected exactly one SecurityPolicy, found {len(security)}", file=sys.stderr)
    sys.exit(1)
if "basicAuth" not in security[0]["spec"]:
    print("FAIL: SecurityPolicy does not configure basicAuth", file=sys.stderr)
    sys.exit(1)
if security[0]["spec"]["targetRefs"][0]["name"] != external_routes[0]["metadata"]["name"]:
    print("FAIL: SecurityPolicy must target only the external HTTPRoute", file=sys.stderr)
    sys.exit(1)
PYEOF

EIGHT_GPU_RENDERED_FILE="$(mktemp)"
TARGET_NODE_RENDERED_FILE="$(mktemp)"
trap 'rm -f "${TLS_RENDERED_FILE}" "${EIGHT_GPU_RENDERED_FILE}" "${TARGET_NODE_RENDERED_FILE}"' EXIT
helm template eight-gpu-policy-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  -f "${CHART_DIR}/values.yaml" \
  --set ingress.allowInsecureHttp=true \
  --set autoscaling.enabled=true \
  --set autoscaling.maxReplicas=8 \
  --set autoscaling.maxGpus=8 \
  >"${EIGHT_GPU_RENDERED_FILE}"
python3 - "${EIGHT_GPU_RENDERED_FILE}" <<'PYEOF'
import sys
import yaml

with open(sys.argv[1]) as f:
    hpa = next(
        doc
        for doc in yaml.safe_load_all(f)
        if doc and doc.get("kind") == "HorizontalPodAutoscaler"
    )

if hpa["spec"]["maxReplicas"] != 8:
    print("FAIL: synchronized eight-GPU settings did not render maxReplicas=8", file=sys.stderr)
    sys.exit(1)
PYEOF

helm template target-node-policy-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  --set ingress.allowInsecureHttp=true \
  --set-string 'nodeSelector.kubernetes\.io/hostname=test-gpu' \
  >"${TARGET_NODE_RENDERED_FILE}"
python3 - "${TARGET_NODE_RENDERED_FILE}" <<'PYEOF'
import sys
import yaml

with open(sys.argv[1]) as f:
    deployment = next(
        doc for doc in yaml.safe_load_all(f) if doc and doc.get("kind") == "Deployment"
    )

selector = deployment["spec"]["template"]["spec"].get("nodeSelector", {})
if selector.get("kubernetes.io/hostname") != "test-gpu":
    print("FAIL: explicit target node did not render on the GPU Deployment", file=sys.stderr)
    sys.exit(1)
if selector.get("nvidia.com/gpu.present") != "true":
    print("FAIL: explicit target node removed the portable GPU selector", file=sys.stderr)
    sys.exit(1)
PYEOF

assert_persistence_render_rejected() {
  local expected_message="${1:?expected message}"
  shift
  local output
  if output="$(helm template persistence-policy-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
    -f "${CHART_DIR}/values.yaml" \
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
  "${AUTH_HELM_SETS[@]}" \
  -f "${CHART_DIR}/values.yaml" \
  --set ingress.allowInsecureHttp=true \
  --set ollama.persistence.enabled=true \
  --set ollama.persistence.accessMode=ReadWriteOnce \
  --set-string ollama.persistence.storageClass= \
  >/dev/null; then
  echo "FAIL: chart rejected the explicit single-node hostPath persistence mode" >&2
  exit 1
fi

VLLM_RENDERED_FILE="$(mktemp)"
NIM_RENDERED_FILE="$(mktemp)"
trap 'rm -f "${TLS_RENDERED_FILE}" "${EIGHT_GPU_RENDERED_FILE}" "${TARGET_NODE_RENDERED_FILE}" "${VLLM_RENDERED_FILE}" "${NIM_RENDERED_FILE}"' EXIT

helm template vllm-runtime-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  --set ingress.allowInsecureHttp=true \
  --set inference.runtime=vllm \
  --set-string inference.model=nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8 \
  >"${VLLM_RENDERED_FILE}"

helm template nim-runtime-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  --set ingress.allowInsecureHttp=true \
  --set inference.runtime=nim \
  --set-string inference.model=nvidia/nemotron-3-nano \
  --set-string nim.ngcApiKey.value=test-ngc-key \
  >"${NIM_RENDERED_FILE}"

python3 - "${VLLM_RENDERED_FILE}" vllm nvcr.io/nvidia/vllm <<'PYEOF'
import sys
import yaml

path, runtime, image_repo = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    docs = [d for d in yaml.safe_load_all(f) if d]
deploy = next(d for d in docs if d.get("kind") == "Deployment")
containers = deploy["spec"]["template"]["spec"]["containers"]
runtime_containers = [c for c in containers if c.get("name") == runtime]
if len(runtime_containers) != 1:
    sys.exit(f"FAIL: expected exactly one {runtime!r} container, found {len(runtime_containers)}")
container = runtime_containers[0]
if not container["image"].startswith(image_repo):
    sys.exit(f"FAIL: {runtime} container image {container['image']!r} does not start with {image_repo!r}")
if not any(p.get("name") == "inference" for p in container.get("ports", [])):
    sys.exit(f"FAIL: {runtime} container does not expose a port named 'inference'")
metrics_proxy = next(c for c in containers if c["name"] == "metrics-proxy")
env = {e["name"]: e.get("value") for e in metrics_proxy.get("env", [])}
if env.get("INFERENCE_RUNTIME") != runtime:
    sys.exit(f"FAIL: metrics-proxy INFERENCE_RUNTIME={env.get('INFERENCE_RUNTIME')!r}, expected {runtime!r}")
volumes = deploy["spec"]["template"]["spec"]["volumes"]
if any(v.get("name") == "scripts" for v in volumes):
    sys.exit(f"FAIL: {runtime} render should not mount the ollama-only 'scripts' volume")
print(f"OK: {runtime} render contract holds (container/image/port/metrics-proxy env)")
PYEOF

python3 - "${NIM_RENDERED_FILE}" <<'PYEOF'
import sys
import yaml

with open(sys.argv[1]) as f:
    docs = [d for d in yaml.safe_load_all(f) if d]
deploy = next(d for d in docs if d.get("kind") == "Deployment")
containers = deploy["spec"]["template"]["spec"]["containers"]
nim_containers = [c for c in containers if c.get("name") == "nim"]
if len(nim_containers) != 1:
    sys.exit(f"FAIL: expected exactly one nim container, found {len(nim_containers)}")
env = {e["name"]: e for e in nim_containers[0].get("env", [])}
ngc_ref = env.get("NGC_API_KEY", {}).get("valueFrom", {}).get("secretKeyRef", {})
secret_name = ngc_ref.get("name")
if not secret_name:
    sys.exit("FAIL: nim container does not source NGC_API_KEY from a Secret")
secrets = [d for d in docs if d.get("kind") == "Secret" and d.get("metadata", {}).get("name") == secret_name]
if len(secrets) != 1:
    sys.exit(f"FAIL: expected the chart to render the generated NIM NGC Secret {secret_name!r}, found {len(secrets)}")
print("OK: nim render contract holds (NGC_API_KEY Secret wiring)")
PYEOF

if BAD_RUNTIME_OUTPUT="$(helm template bad-runtime-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  --set ingress.allowInsecureHttp=true \
  --set inference.runtime=bogus 2>&1)"; then
  echo "FAIL: chart rendered unsupported inference.runtime=bogus" >&2
  exit 1
fi
if [[ "${BAD_RUNTIME_OUTPUT}" != *"unsupported"* ]] || [[ "${BAD_RUNTIME_OUTPUT}" != *"bogus"* ]]; then
  echo "FAIL: unsupported inference.runtime rejection returned an unexpected error" >&2
  printf '%s\n' "${BAD_RUNTIME_OUTPUT}" >&2
  exit 1
fi
echo "OK: chart rejects unsupported inference.runtime values"

if NIM_NO_KEY_OUTPUT="$(helm template nim-missing-key-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  --set ingress.allowInsecureHttp=true \
  --set inference.runtime=nim 2>&1)"; then
  echo "FAIL: chart rendered inference.runtime=nim without an NGC API key" >&2
  exit 1
fi
if [[ "${NIM_NO_KEY_OUTPUT}" != *"nim.ngcApiKey"* ]]; then
  echo "FAIL: missing NIM NGC API key rejection returned an unexpected error" >&2
  printf '%s\n' "${NIM_NO_KEY_OUTPUT}" >&2
  exit 1
fi
echo "OK: chart requires an NGC API key when inference.runtime=nim"

RENDERED_FILE="$(mktemp)"
trap 'rm -f "${TLS_RENDERED_FILE}" "${EIGHT_GPU_RENDERED_FILE}" "${TARGET_NODE_RENDERED_FILE}" "${VLLM_RENDERED_FILE}" "${NIM_RENDERED_FILE}" "${RENDERED_FILE}"' EXIT
# A legacy non-GPU metric-name override must not alter the fixed HPA metric.
helm template test-release "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" -f "${CHART_DIR}/values.yaml" \
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
secrets = by_kind.get("Secret", [])

if deploy:
    deploy_name = deploy["metadata"]["name"]
    pod_labels = deploy["spec"]["template"]["metadata"]["labels"]
    deploy_selector = deploy["spec"]["selector"]["matchLabels"]

    metrics_proxy_containers = [
        c for c in deploy["spec"]["template"]["spec"]["containers"] if c.get("name") == "metrics-proxy"
    ]
    if len(metrics_proxy_containers) != 1:
        failures.append(f"expected exactly one metrics-proxy container, found {len(metrics_proxy_containers)}")
    elif metrics_proxy_containers[0].get("command") != ["node", "/app/metrics-proxy-server.ts"]:
        failures.append("metrics-proxy container does not execute the mounted TypeScript entry point")
    else:
        env = {item["name"]: item for item in metrics_proxy_containers[0].get("env", [])}
        if env.get("INFERENCE_AUTH_REQUIRED", {}).get("value") != "true":
            failures.append("metrics-proxy container does not require inference authentication")
        api_key_ref = (
            env.get("INFERENCE_API_KEY", {})
            .get("valueFrom", {})
            .get("secretKeyRef", {})
        )
        if api_key_ref != {"name": f"{deploy_name}-inference-api", "key": "api-key"}:
            failures.append(f"metrics-proxy inference API Secret reference is incorrect: {api_key_ref!r}")

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
            failures.append("app volume does not mount package.json next to metrics-proxy-server.ts")

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
                    f"HPA Pods metric={metric_name!r}, expected 'gpu_utilization_percent' for default metric=gpu_utilization"
                )
            target_value = gpu_metric["target"]["averageValue"]
            if str(target_value) != "40":
                failures.append(
                    f"HPA gpu_utilization_percent averageValue={target_value!r}, expected 40 "
                    "(values.yaml default targetGPUUtilizationPercentage)"
                )
        hpa_mode = hpa.get("metadata", {}).get("annotations", {}).get("nemoclaw.ai/hpa-mode")
        if hpa_mode != "gpu_utilization":
            failures.append(f"HPA mode annotation={hpa_mode!r}, expected 'gpu_utilization'")

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
        inference_volumes = [v for v in volumes if v.get("name") == "inference-data"]
        if len(inference_volumes) != 1:
            failures.append(
                f"expected exactly one inference-data volume, found {len(inference_volumes)}"
            )
        elif inference_volumes[0].get("persistentVolumeClaim", {}).get("claimName") != pvc_name:
            failures.append("Deployment inference-data volume does not reference the rendered PVC")

if config:
    package_json = config.get("data", {}).get("package.json")
    try:
        package_metadata = json.loads(package_json or "")
    except json.JSONDecodeError:
        failures.append("metrics-proxy ConfigMap package.json is not valid JSON")
    else:
        if package_metadata != {"type": "module"}:
            failures.append(
                f"metrics-proxy ConfigMap package.json={package_metadata!r}, expected ESM metadata"
            )

expected_inference_secret_name = (
    f"{deploy['metadata']['name']}-inference-api" if deploy else None
)
inference_secrets = [
    secret
    for secret in secrets
    if secret.get("metadata", {}).get("name") == expected_inference_secret_name
]
if expected_inference_secret_name and len(inference_secrets) != 1:
    failures.append(
        "expected exactly one generated inference API Secret "
        f"named {expected_inference_secret_name}, found {len(inference_secrets)}"
    )
elif inference_secrets and "api-key" not in inference_secrets[0].get("data", {}):
    failures.append("generated inference API Secret does not contain api-key")

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

EXISTING_SECRET_RENDERED_FILE="$(mktemp)"
DOTTED_KEY_RENDERED_FILE="$(mktemp)"
trap 'rm -f "${TLS_RENDERED_FILE}" "${EIGHT_GPU_RENDERED_FILE}" "${TARGET_NODE_RENDERED_FILE}" "${RENDERED_FILE}" "${EXISTING_SECRET_RENDERED_FILE}" "${DOTTED_KEY_RENDERED_FILE}"' EXIT
OPERATOR_SECRET_NAME='operator-inference-api.gpu-platform.production.cluster.example.internal'
helm template existing-secret-policy-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  --set ingress.allowInsecureHttp=true \
  --set-string "inference.auth.existingSecret=${OPERATOR_SECRET_NAME}" \
  --set-string inference.auth.key=true \
  >"${EXISTING_SECRET_RENDERED_FILE}"
python3 - "${EXISTING_SECRET_RENDERED_FILE}" "${OPERATOR_SECRET_NAME}" <<'PYEOF'
import sys
import yaml

with open(sys.argv[1]) as f:
    docs = [doc for doc in yaml.safe_load_all(f) if doc]
operator_secret_name = sys.argv[2]

generated = [
    doc
    for doc in docs
    if doc.get("kind") == "Secret"
    and doc.get("metadata", {}).get("name") == operator_secret_name
]
if generated:
    print("FAIL: chart generated the operator-managed inference Secret", file=sys.stderr)
    sys.exit(1)

deployment = next(doc for doc in docs if doc.get("kind") == "Deployment")
proxy = next(
    container
    for container in deployment["spec"]["template"]["spec"]["containers"]
    if container["name"] == "metrics-proxy"
)
env = {item["name"]: item for item in proxy["env"]}
secret_ref = env["INFERENCE_API_KEY"]["valueFrom"]["secretKeyRef"]
if secret_ref != {"name": operator_secret_name, "key": "true"}:
    print(f"FAIL: operator-managed inference Secret reference is incorrect: {secret_ref!r}", file=sys.stderr)
    sys.exit(1)
PYEOF

helm template dotted-key-policy-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  --set ingress.allowInsecureHttp=true \
  --set-string inference.auth.key=api.key \
  >"${DOTTED_KEY_RENDERED_FILE}"
python3 - "${DOTTED_KEY_RENDERED_FILE}" <<'PYEOF'
import sys
import yaml

with open(sys.argv[1]) as f:
    docs = [doc for doc in yaml.safe_load_all(f) if doc]

secret = next(doc for doc in docs if doc.get("kind") == "Secret" and doc.get("type") == "Opaque")
if "api.key" not in secret.get("data", {}):
    print("FAIL: generated inference Secret does not preserve a dotted key", file=sys.stderr)
    sys.exit(1)

deployment = next(doc for doc in docs if doc.get("kind") == "Deployment")
proxy = next(container for container in deployment["spec"]["template"]["spec"]["containers"] if container["name"] == "metrics-proxy")
env = {item["name"]: item for item in proxy["env"]}
key = env["INFERENCE_API_KEY"]["valueFrom"]["secretKeyRef"]["key"]
if key != "api.key":
    print(f"FAIL: Deployment does not preserve dotted inference Secret key: {key!r}", file=sys.stderr)
    sys.exit(1)
PYEOF

LATENCY_RENDERED_FILE="$(mktemp)"
trap 'rm -f "${TLS_RENDERED_FILE}" "${EIGHT_GPU_RENDERED_FILE}" "${TARGET_NODE_RENDERED_FILE}" "${RENDERED_FILE}" "${EXISTING_SECRET_RENDERED_FILE}" "${DOTTED_KEY_RENDERED_FILE}" "${LATENCY_RENDERED_FILE}"' EXIT
helm template latency-metric-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  -f "${CHART_DIR}/values.yaml" \
  --set autoscaling.enabled=true \
  --set-string autoscaling.metric=latency_avg \
  --set autoscaling.targetLatencyMilliseconds=3000 \
  --set ingress.allowInsecureHttp=true >"${LATENCY_RENDERED_FILE}"
python3 - "${LATENCY_RENDERED_FILE}" <<'PYEOF'
import sys
import yaml

docs = [doc for doc in yaml.safe_load_all(open(sys.argv[1])) if doc]
hpa = next(doc for doc in docs if doc.get("kind") == "HorizontalPodAutoscaler")
metric = hpa["spec"]["metrics"][0]["pods"]
name = metric["metric"]["name"]
target = metric["target"]["averageValue"]
if name != "nemoclaw_llm_latency_avg_milliseconds":
    print(f"FAIL: latency_avg HPA metric={name!r}", file=sys.stderr)
    sys.exit(1)
if str(target) != "3000":
    print(f"FAIL: latency_avg target={target!r}, expected '3000'", file=sys.stderr)
    sys.exit(1)
PYEOF
echo "OK: chart renders latency_avg HPA metric mode"

if BAD_METRIC_OUTPUT="$(helm template bad-metric-check "${CHART_DIR}" \
  "${AUTH_HELM_SETS[@]}" \
  -f "${CHART_DIR}/values.yaml" \
  --set autoscaling.enabled=true \
  --set-string autoscaling.metric=not_a_real_metric \
  --set ingress.allowInsecureHttp=true 2>&1)"; then
  echo "FAIL: chart rendered unsupported autoscaling.metric=not_a_real_metric" >&2
  exit 1
fi
if [[ "${BAD_METRIC_OUTPUT}" != *"unsupported"* ]] \
  || [[ "${BAD_METRIC_OUTPUT}" != *"not_a_real_metric"* ]]; then
  echo "FAIL: unknown metric rejection returned an unexpected error" >&2
  printf '%s\n' "${BAD_METRIC_OUTPUT}" >&2
  exit 1
fi
echo "OK: chart rejects unknown HPA metric modes"

for RETIRED_METRIC in latency_p50 latency_p95 request_rate; do
  case "${RETIRED_METRIC}" in
    latency_p50) RETIRED_RELEASE="retired-latency-p50" ;;
    latency_p95) RETIRED_RELEASE="retired-latency-p95" ;;
    request_rate) RETIRED_RELEASE="retired-request-rate" ;;
    *) RETIRED_RELEASE="retired-metric" ;;
  esac
  if RETIRED_OUTPUT="$(helm template "${RETIRED_RELEASE}" "${CHART_DIR}" \
    "${AUTH_HELM_SETS[@]}" \
    -f "${CHART_DIR}/values.yaml" \
    --set autoscaling.enabled=true \
    --set-string "autoscaling.metric=${RETIRED_METRIC}" \
    --set ingress.allowInsecureHttp=true 2>&1)"; then
    echo "FAIL: chart rendered retired autoscaling.metric=${RETIRED_METRIC}" >&2
    exit 1
  fi
  if [[ "${RETIRED_OUTPUT}" != *"unsupported"* ]] \
    || [[ "${RETIRED_OUTPUT}" != *"${RETIRED_METRIC}"* ]]; then
    echo "FAIL: retired metric ${RETIRED_METRIC} rejection returned an unexpected error" >&2
    printf '%s\n' "${RETIRED_OUTPUT}" >&2
    exit 1
  fi
done
echo "OK: chart rejects retired HPA metric modes (latency_p50, latency_p95, request_rate)"

echo "OK: chart rejects cleartext Gateway without explicit opt-in"
echo "OK: chart requires in-cluster inference authentication"
echo "OK: chart supports an operator-managed inference Secret"
echo "OK: chart preserves long Secret names and scalar-like or dotted Secret keys"
echo "OK: Helm NOTES commands do not depend on the chart source directory"
echo "OK: chart enforces HTTPS redirect, OpenShell HTTP LeastRequest, and external LeastRequest"
echo "OK: synchronized replica and GPU caps permit an eight-GPU Kubernetes HPA"
echo "OK: chart requires an explicit ReadWriteMany storage class for shared PVC persistence"
echo "OK: chart preserves the explicit single-node hostPath persistence mode"
echo "OK: vllm render contract holds (container/image/port/metrics-proxy env)"
echo "OK: nim render contract holds (NGC_API_KEY Secret wiring)"
echo "OK: chart rejects unsupported inference.runtime values"
echo "OK: chart requires an NGC API key when inference.runtime=nim"
