#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# One-time, Secret-first NIM registry setup. Prompts for an NGC key without echoing it,
# then creates the two namespace-scoped Secrets NIM needs: NGC_API_KEY for the running
# container and a dockerconfigjson imagePullSecret for kubelet's nvcr.io pull.
#
# Usage:
#   NAMESPACE=nemoclaw-gpu ./scripts/create-nim-ngc-secrets.sh
#   NAMESPACE=nemoclaw-gpu ./scripts/create-nim-ngc-secrets.sh --replace

set -euo pipefail

NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
NGC_SECRET_NAME="${NIM_NGC_API_KEY_SECRET:-nim-ngc-key}"
REGISTRY_SECRET_NAME="${NIM_IMAGE_PULL_SECRET:-ngc-registry}"
REPLACE=0

case "${1:-}" in
  "") ;;
  --replace) REPLACE=1 ;;
  -h | --help)
    sed -n '1,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Usage: NAMESPACE=<namespace> $0 [--replace]" >&2
    exit 2
    ;;
esac

valid_k8s_name() {
  [[ "${1}" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]]
}

for value in "${NAMESPACE}" "${NGC_SECRET_NAME}" "${REGISTRY_SECRET_NAME}"; do
  valid_k8s_name "${value}" || {
    echo "NAMESPACE and Secret names must be valid Kubernetes DNS subdomain names." >&2
    exit 1
  }
done

command -v kubectl >/dev/null 2>&1 || {
  echo "kubectl is required" >&2
  exit 1
}
command -v base64 >/dev/null 2>&1 || {
  echo "base64 is required" >&2
  exit 1
}

if [[ "${REPLACE}" != "1" ]] && \
  { kubectl get secret "${NGC_SECRET_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1 || \
    kubectl get secret "${REGISTRY_SECRET_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1; }; then
  cat >&2 <<EOF
One or both NIM Secrets already exist in ${NAMESPACE}; refusing to overwrite credentials.
Inspect them first, or rerun with --replace only when you intend to rotate both Secrets.
EOF
  exit 1
fi

if [[ -z "${NGC_API_KEY:-}" ]]; then
  [[ -t 0 && -t 1 ]] || {
    echo "No interactive terminal. Provide NGC_API_KEY from your secret manager for this command." >&2
    exit 1
  }
  IFS= read -r -s -p "NGC API key (input hidden): " NGC_API_KEY
  printf '\n' >&2
fi

# NGC API keys have the nvapi- form. Restrict the accepted alphabet so the key can be
# embedded safely in the generated dockerconfigjson without exposing it on command argv.
if [[ ! "${NGC_API_KEY}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "NGC_API_KEY is empty or contains unsupported characters." >&2
  exit 1
fi

cleanup() {
  unset NGC_API_KEY docker_auth docker_config
}
trap cleanup EXIT

kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# --from-file receives a /dev/fd path, not the credential; the key is never written to a
# local file, shell history, or kubectl command-line argument.
kubectl create secret generic "${NGC_SECRET_NAME}" -n "${NAMESPACE}" \
  --from-file=NGC_API_KEY=<(printf '%s' "${NGC_API_KEY}") \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

docker_auth="$(printf '%s' "\$oauthtoken:${NGC_API_KEY}" | base64 | tr -d '\n')"
docker_config="{\"auths\":{\"nvcr.io\":{\"username\":\"\$oauthtoken\",\"password\":\"${NGC_API_KEY}\",\"auth\":\"${docker_auth}\"}}}"
kubectl create secret generic "${REGISTRY_SECRET_NAME}" -n "${NAMESPACE}" \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=<(printf '%s' "${docker_config}") \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

cat <<EOF
Created NIM credentials in namespace ${NAMESPACE}:
  ${NGC_SECRET_NAME}        (Opaque; key NGC_API_KEY)
  ${REGISTRY_SECRET_NAME}   (kubernetes.io/dockerconfigjson for nvcr.io)

Add only these Secret names to gitignored local.env:
  export INFERENCE_RUNTIME=nim
  export NIM_NGC_API_KEY_SECRET=${NGC_SECRET_NAME}
  export NIM_IMAGE_PULL_SECRET=${REGISTRY_SECRET_NAME}
EOF
