#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Check whether this cluster can run the experimental v1 GPU-autoscaling YAML.
# Validates YAML against the v1 schema. Does not apply. Does not print secrets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# This folder lives inside the NemoClaw v1 checkout. Override when validating against another checkout.
V1_ROOT="${NEMOCLAW_V1_ROOT:-$(cd "${EXAMPLE_DIR}/../../.." && pwd)}"
SCHEMA="${V1_ROOT}/schemas/nemoclaw-v1alpha1.schema.json"
GPU_NS="${GPU_NS:-nemoclaw-gpu}"
SANDBOX_NS="${SANDBOX_NS:-nemoclaw-sandboxes}"
V1_NS="nemoclaw-v1-gpu-autoscaling"

pass=0
warn=0
fail=0
apply_blocked=0

log() { printf '%s\n' "$*"; }
ok() { log "OK    $*"; pass=$((pass + 1)); }
note() { log "WARN  $*"; warn=$((warn + 1)); }
bad() { log "FAIL  $*"; fail=$((fail + 1)); }
block() { log "BLOCK $*"; apply_blocked=1; warn=$((warn + 1)); }

log "v1 checkout ${V1_ROOT}"
log "example ${EXAMPLE_DIR}"

if [[ ! -f "${SCHEMA}" ]]; then
  bad "missing schema ${SCHEMA}"
else
  ok "schema ${SCHEMA}"
fi

YAML_FILES=()
for name in hermes-nim hermes-vllm deepagents-nim openclaw-ollama; do
  YAML_FILES+=("${EXAMPLE_DIR}/${name}.yaml")
done

if ! command -v python3 >/dev/null 2>&1; then
  bad "python3 is required for schema validation"
else
  if python3 "${SCRIPT_DIR}/v1-validate-yaml.py" --schema "${SCHEMA}" "${YAML_FILES[@]}"; then
    ok "schema and in-cluster Service /v1 checks accepted all four pairing files"
  else
    bad "jsonschema rejected one or more pairing files"
  fi
fi

if ! command -v kubectl >/dev/null 2>&1; then
  block "kubectl not on PATH"
else
  ctx="$(kubectl config current-context 2>/dev/null || true)"
  if [[ -z "${ctx}" ]]; then
    block "no kubectl context"
  else
    ok "kubectl context ${ctx}"
  fi

  sc_count="$(kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | awk 'NF' | wc -l | tr -d ' ')"
  default_sc="$(kubectl get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  if [[ "${sc_count}" == "1" && -n "${default_sc}" ]]; then
    ok "one default StorageClass (${default_sc})"
  else
    block "managed Kubernetes needs exactly one default StorageClass (found ${sc_count}; default='${default_sc}')"
  fi

  if kubectl get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1; then
    ok "Agent Sandbox CRD is present"
  else
    block "Agent Sandbox CRD sandboxes.agents.x-k8s.io is missing"
  fi

  if kubectl -n "${GPU_NS}" get deploy nemoclaw-gpu-metrics-proxy >/dev/null 2>&1; then
    ok "GPU metrics-proxy Deployment exists in ${GPU_NS}"
  else
    block "GPU chart metrics-proxy Deployment missing in ${GPU_NS}"
  fi

  gpu_images="$(kubectl -n "${GPU_NS}" get pods -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' 2>/dev/null || true)"
  runtime="unknown"
  if printf '%s\n' "${gpu_images}" | grep -q '/nim/'; then
    runtime="nim"
  elif printf '%s\n' "${gpu_images}" | grep -qi vllm; then
    runtime="vllm"
  elif printf '%s\n' "${gpu_images}" | grep -qi ollama; then
    runtime="ollama"
  fi
  log "INFO  GPU runtime guess: ${runtime}"
  case "${runtime}" in
    nim)
      ok "use hermes-nim.yaml or deepagents-nim.yaml (do not helm-upgrade to vLLM)"
      ;;
    vllm)
      ok "use hermes-vllm.yaml"
      ;;
    ollama)
      ok "use openclaw-ollama.yaml"
      ;;
    *)
      note "could not classify GPU runtime from pod images"
      ;;
  esac

  if kubectl -n "${GPU_NS}" get secret nemoclaw-gpu-metrics-proxy-inference-api >/dev/null 2>&1; then
    ok "inference API Secret exists (value not printed)"
  else
    block "missing Secret nemoclaw-gpu-metrics-proxy-inference-api"
  fi

  envoy="$(kubectl -n envoy-gateway-system get svc -l app.kubernetes.io/component=proxy -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -n "${envoy}" ]]; then
    ok "Envoy dataplane Service ${envoy}.envoy-gateway-system.svc.cluster.local:80"
    log "INFO  YAML uses metrics-proxy Service DNS. On this DGX, ClusterIP hairpin can drop SYNs; v0 used the Envoy pod IP."
  else
    note "no Envoy dataplane Service; YAML still points at the metrics-proxy Service"
  fi

  if kubectl get ns "${V1_NS}" >/dev/null 2>&1; then
    note "namespace ${V1_NS} already exists. v1 apply refuses to take over an existing namespace."
  else
    ok "namespace ${V1_NS} does not exist yet"
  fi

  v0_pods="$(kubectl -n "${SANDBOX_NS}" get pods --no-headers 2>/dev/null | awk '$3=="Running"{print $1}')"
  sample="$(printf '%s\n' "${v0_pods}" | awk '/hermes-vllm-e2e-|deepagent-nim-e2e-/{print; exit}')"
  if [[ -n "${sample}" ]]; then
    note "v0 e2e sandboxes are Running in ${SANDBOX_NS}. Leave them. Do not apply v1 over them."
    if kubectl -n "${SANDBOX_NS}" exec "${sample}" -- sh -c 'command -v fabric-agent-ctl >/dev/null && echo yes || echo no' >/dev/null 2>&1; then
      has_fabric="$(kubectl -n "${SANDBOX_NS}" exec "${sample}" -- sh -c 'command -v fabric-agent-ctl >/dev/null && echo yes || echo no' 2>/dev/null | tail -n 1)"
      if [[ "${has_fabric}" == "yes" ]]; then
        ok "${sample} has fabric-agent-ctl"
      else
        block "${sample} has no fabric-agent-ctl. v0 images cannot run v1 step 6."
      fi
    fi
  else
    ok "no v0 hermes/deepagents e2e pods found"
  fi
fi

if command -v openshell >/dev/null 2>&1; then
  os_ver="$(openshell --version 2>/dev/null | awk '{print $NF; exit}')"
  log "INFO  openshell ${os_ver}"
  if [[ "${os_ver}" == "0.1.4" ]]; then
    ok "OpenShell CLI is 0.1.4"
  else
    block "v1 needs OpenShell 0.1.4. This CLI is ${os_ver:-unknown}. Do not point v1 at the v0.0.85 gateway."
  fi
else
  block "openshell CLI is missing"
fi

if command -v nemoclaw >/dev/null 2>&1; then
  ok "nemoclaw is on PATH ($(command -v nemoclaw))"
else
  block "nemoclaw CLI is missing. Build a v1 bundle from source (docs/build.md)."
fi

if command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
  ok "rustc $(rustc --version 2>/dev/null | awk '{print $2}')"
else
  block "rustc/cargo missing. v1 has no release download (#12638)."
fi

if command -v docker >/dev/null 2>&1; then
  ok "docker is on PATH"
else
  block "docker is missing. v1 Fabric agent images need Docker Buildx."
fi

if [[ -z "${NEMOCLAW_CLUSTER_KUBECONFIG:-}" ]]; then
  note "set NEMOCLAW_CLUSTER_KUBECONFIG to the kubeconfig file path before plan/apply"
else
  ok "NEMOCLAW_CLUSTER_KUBECONFIG is set (path not printed)"
fi

if [[ -z "${NEMOCLAW_AGENT_IMAGE_METADATA:-}" ]]; then
  block "NEMOCLAW_AGENT_IMAGE_METADATA is unset. Export metadata from a built Fabric image."
else
  ok "NEMOCLAW_AGENT_IMAGE_METADATA is set (path not printed)"
fi

if [[ -z "${GPU_INFERENCE_API_KEY:-}" ]]; then
  note "GPU_INFERENCE_API_KEY is unset. Export it from the GPU chart Secret before apply. Do not echo it."
else
  ok "GPU_INFERENCE_API_KEY is set (value not printed)"
fi

log ""
log "summary: pass=${pass} warn=${warn} fail=${fail} apply_blocked=${apply_blocked}"
if ((fail > 0)); then
  exit 1
fi
if ((apply_blocked > 0)); then
  log "Live apply is blocked. Schema/render checks can still pass."
  exit 0
fi
log "No apply blockers recorded. Plan still needs a real image digest and a v1 bundle."
exit 0
