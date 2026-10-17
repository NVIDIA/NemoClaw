#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Install the OpenShell Kubernetes gateway. The cluster-wide Agent Sandbox controller
# remains an explicit operator step; this script verifies it but never installs it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=../versions.env
source "${CHART_DIR}/versions.env"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

require_cmd helm
require_cmd kubectl

# The chart's server-wide default sandboxImage; each sandbox create call in
# scripts/create-agent-sandbox.sh always overrides it with that agent's own `--from`
# image, so this is effectively only ever used as a required placeholder — but it must
# still be a valid, pullable image reference (the same one you built for AGENT_NAME).
SANDBOX_IMAGE="${AGENT_SANDBOX_IMAGE:-}"
NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
RELEASE="${OPENSHELL_RELEASE:-openshell}"
OIDC_ISSUER="${OPENSHELL_OIDC_ISSUER:-}"
OIDC_AUDIENCE="${OPENSHELL_OIDC_AUDIENCE:-openshell-cli}"
ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED_OPENSHELL:-0}"
IMAGE_PULL_SECRET="${OPENSHELL_IMAGE_PULL_SECRET:-}"
IMAGE_NAME="${SANDBOX_IMAGE##*/}"

[[ -n "${SANDBOX_IMAGE}" ]] || fail "set AGENT_SANDBOX_IMAGE to the pushed sandbox image"
[[ "${SANDBOX_IMAGE}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]+$ ]] \
  || fail "AGENT_SANDBOX_IMAGE contains unsupported characters"
if [[ "${SANDBOX_IMAGE}" == *@* ]]; then
  [[ "${SANDBOX_IMAGE}" =~ @sha256:[0-9a-f]{64}$ ]] \
    || fail "AGENT_SANDBOX_IMAGE contains an invalid digest"
else
  [[ "${IMAGE_NAME}" == *:* && "${SANDBOX_IMAGE}" != *:latest ]] \
    || fail "AGENT_SANDBOX_IMAGE must use a non-latest tag or an image digest"
fi
[[ "${NAMESPACE}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
  || fail "OPENSHELL_NAMESPACE must be a valid lowercase Kubernetes namespace"
[[ "${RELEASE}" =~ ^[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] \
  || fail "OPENSHELL_RELEASE must be a 2-63 character lowercase Kubernetes-style name"
kubectl get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1 \
  || fail "Agent Sandbox CRD is missing; install the pinned ${AGENT_SANDBOX_VERSION} manifest first"
hpa_common_verify_target_node 1 || exit 1

case "${ALLOW_UNAUTHENTICATED}" in
  0)
    [[ -n "${OIDC_ISSUER}" ]] \
      || fail "set OPENSHELL_OIDC_ISSUER, or explicitly choose the isolated evaluation exception documented in README"
    [[ "${OIDC_ISSUER}" =~ ^https://[^[:space:],]+$ ]] \
      || fail "OPENSHELL_OIDC_ISSUER must be an https URL without commas"
    [[ "${OIDC_AUDIENCE}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]] \
      || fail "OPENSHELL_OIDC_AUDIENCE is invalid"
    ;;
  1)
    [[ "${OPENSHELL_UNAUTHENTICATED_ACK:-}" == "dedicated-cluster-port-forward-only" ]] \
      || fail "set OPENSHELL_UNAUTHENTICATED_ACK=dedicated-cluster-port-forward-only after verifying this is a dedicated evaluation cluster"
    [[ -z "${OIDC_ISSUER}" ]] \
      || fail "unset OPENSHELL_OIDC_ISSUER when choosing the unauthenticated evaluation exception"
    ;;
  *) fail "ALLOW_UNAUTHENTICATED_OPENSHELL must be 0 or 1" ;;
esac

if [[ "${ALLOW_UNAUTHENTICATED}" == 1 ]]; then
  UNAUTHENTICATED_VALUE=true
else
  UNAUTHENTICATED_VALUE=false
fi

HELM_ARGS=(
  upgrade --install "${RELEASE}"
  oci://ghcr.io/nvidia/openshell/helm-chart
  --version "${OPENSHELL_VERSION}"
  --namespace "${NAMESPACE}"
  --create-namespace
  --set-string "fullnameOverride=${RELEASE}"
  --set-string "server.sandboxNamespace=${NAMESPACE}"
  --set-string "server.sandboxImage=${SANDBOX_IMAGE}"
  --set-string "server.sandboxImagePullPolicy=IfNotPresent"
  --set-string "supervisor.topology=combined"
  --set-string "service.type=ClusterIP"
  --set "server.auth.allowUnauthenticatedUsers=${UNAUTHENTICATED_VALUE}"
)

if [[ -n "${OIDC_ISSUER}" ]]; then
  HELM_ARGS+=(
    --set-string "server.oidc.issuer=${OIDC_ISSUER}"
    --set-string "server.oidc.audience=${OIDC_AUDIENCE}"
  )
fi
if [[ -n "${IMAGE_PULL_SECRET}" ]]; then
  [[ "${IMAGE_PULL_SECRET}" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] \
    || fail "OPENSHELL_IMAGE_PULL_SECRET contains unsupported characters"
  kubectl get secret "${IMAGE_PULL_SECRET}" -n "${NAMESPACE}" >/dev/null 2>&1 \
    || fail "image pull Secret ${IMAGE_PULL_SECRET} does not exist in ${NAMESPACE}"
  HELM_ARGS+=(--set-string "server.sandboxImagePullSecrets[0].name=${IMAGE_PULL_SECRET}")
fi
if [[ -n "${NEMOCLAW_TARGET_NODE:-}" ]]; then
  HELM_ARGS+=(
    --set-string "$(hpa_common_target_node_helm_value)"
    --set-string 'tolerations[0].key=nvidia.com/gpu'
    --set-string 'tolerations[0].operator=Exists'
    --set-string 'tolerations[0].effect=NoSchedule'
  )
fi

helm "${HELM_ARGS[@]}"
kubectl rollout status "statefulset/${RELEASE}" -n "${NAMESPACE}" --timeout=300s

SERVICE_TYPE="$(kubectl get service "${RELEASE}" -n "${NAMESPACE}" -o jsonpath='{.spec.type}')"
EXTERNAL_IPS="$(kubectl get service "${RELEASE}" -n "${NAMESPACE}" -o jsonpath='{.spec.externalIPs[*]}')"
LOAD_BALANCER="$(kubectl get service "${RELEASE}" -n "${NAMESPACE}" -o jsonpath='{.status.loadBalancer.ingress[*].ip}{.status.loadBalancer.ingress[*].hostname}')"
[[ "${SERVICE_TYPE}" == "ClusterIP" && -z "${EXTERNAL_IPS}" && -z "${LOAD_BALANCER}" ]] \
  || fail "OpenShell gateway exposure preflight failed: expected an internal-only ClusterIP Service"
if kubectl get ingress -n "${NAMESPACE}" -o name 2>/dev/null | grep -q .; then
  fail "OpenShell gateway exposure preflight failed: an Ingress exists in ${NAMESPACE}"
fi

echo "OpenShell ${OPENSHELL_VERSION} is ready in namespace ${NAMESPACE}."
if [[ "${ALLOW_UNAUTHENTICATED}" == 1 ]]; then
  echo "WARNING: unauthenticated user API is enabled for a dedicated, port-forward-only evaluation."
else
  echo "OIDC user authentication is enabled for issuer ${OIDC_ISSUER}."
fi
echo "Next: port-forward service/${RELEASE} and register it with the OpenShell CLI as documented in README."
