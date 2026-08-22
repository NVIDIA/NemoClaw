#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=../versions.env
source "${CHART_DIR}/versions.env"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"

[[ "${NEMOCLAW_VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${NEMOCLAW_COMMIT}" =~ ^[0-9a-f]{40}$ ]]
[[ "${OPENSHELL_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${AGENT_SANDBOX_VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]

INSTALL_SCRIPT="${SCRIPT_DIR}/install-openshell-k8s.sh"

grep -Fq -- '--set "server.auth.allowUnauthenticatedUsers=${UNAUTHENTICATED_VALUE}"' "${INSTALL_SCRIPT}"
if grep -Fq -- '--set-string "server.auth.allowUnauthenticatedUsers=' "${INSTALL_SCRIPT}"; then
  echo "FAIL: OpenShell unauthenticated-user policy must be a Helm boolean, not a truthy string" >&2
  exit 1
fi
grep -Fq 'service.type=ClusterIP' "${INSTALL_SCRIPT}"
grep -Fq 'kubectl get crd sandboxes.agents.x-k8s.io' "${INSTALL_SCRIPT}"
grep -Fq 'hpa_common_verify_target_node 1' "${INSTALL_SCRIPT}"
grep -Fq 'hpa_common_target_node_helm_value' "${INSTALL_SCRIPT}"
grep -Fq "'tolerations[0].key=nvidia.com/gpu'" "${INSTALL_SCRIPT}"
grep -Fq 'hpa_common_inference_secret_contract' "${SCRIPT_DIR}/hpa-load-test.sh"
grep -Fq 'ENABLE_ENVOY_LB' "${SCRIPT_DIR}/install-hpa.sh"
grep -Fq 'ingress.gateway.enabled' "${SCRIPT_DIR}/hpa-common.sh"

# --- agent-common.sh config-table contract ------------------------------------
# Every agent must resolve to a non-empty value for every lookup function, and the
# per-agent facts asserted below must not silently drift from the upstream sources
# they were derived from (NemoClaw Dockerfiles / manifests / policy files).

for agent in openclaw hermes deepagents; do
  agent_common_validate "${agent}"
  [[ -n "$(agent_common_display_name "${agent}")" ]] || { echo "FAIL: ${agent} has no display name" >&2; exit 1; }
  [[ -n "$(agent_common_default_sandbox_name "${agent}")" ]] || { echo "FAIL: ${agent} has no default sandbox name" >&2; exit 1; }
  [[ -n "$(agent_common_default_provider_name "${agent}")" ]] || { echo "FAIL: ${agent} has no default provider name" >&2; exit 1; }
  [[ -n "$(agent_common_dockerfile_rel_path "${agent}")" ]] || { echo "FAIL: ${agent} has no Dockerfile path" >&2; exit 1; }
  [[ -n "$(agent_common_base_image_repo "${agent}")" ]] || { echo "FAIL: ${agent} has no base image repo" >&2; exit 1; }
  [[ -n "$(agent_common_policy_rel_path "${agent}")" ]] || { echo "FAIL: ${agent} has no policy path" >&2; exit 1; }
  case "$(agent_common_run_mode "${agent}")" in
    gateway | terminal) ;;
    *) echo "FAIL: ${agent} has an unknown run mode" >&2; exit 1 ;;
  esac
done
if (agent_common_validate not-a-real-agent) 2>/dev/null; then
  echo "FAIL: agent_common_validate must reject an unknown AGENT_NAME" >&2
  exit 1
fi

[[ "$(agent_common_dockerfile_rel_path openclaw)" == "Dockerfile" ]]
[[ "$(agent_common_dockerfile_rel_path hermes)" == "agents/hermes/Dockerfile" ]]
[[ "$(agent_common_dockerfile_rel_path deepagents)" == "agents/langchain-deepagents-code/Dockerfile" ]]
[[ "$(agent_common_policy_rel_path openclaw)" == "nemoclaw-blueprint/policies/openclaw-sandbox.yaml" ]]
[[ "$(agent_common_policy_rel_path hermes)" == "agents/hermes/policy-additions.yaml" ]]
[[ "$(agent_common_policy_rel_path deepagents)" == "agents/langchain-deepagents-code/policy-additions.yaml" ]]
[[ "$(agent_common_run_mode openclaw)" == "gateway" ]]
[[ "$(agent_common_run_mode hermes)" == "gateway" ]]
[[ "$(agent_common_run_mode deepagents)" == "terminal" ]]
agent_common_grants_nvidia_endpoint openclaw
agent_common_grants_nvidia_endpoint hermes
if agent_common_grants_nvidia_endpoint deepagents; then
  echo "FAIL: deepagents policy never grants integrate.api.nvidia.com; there is nothing to remove" >&2
  exit 1
fi
[[ "$(agent_common_extra_build_args openclaw llama3.2:3b)" == "NEMOCLAW_PRIMARY_MODEL_REF=inference/llama3.2:3b" ]]
[[ -z "$(agent_common_extra_build_args hermes llama3.2:3b)" ]]
[[ -z "$(agent_common_extra_build_args deepagents llama3.2:3b)" ]]

# --- generic agent sandbox script contract -------------------------------------
# One script per lifecycle step, shared by all three agents via AGENT_NAME — see
# ../AGENT-SELECTION.md. No per-agent script files exist anymore.

BUILD_SCRIPT="${SCRIPT_DIR}/build-agent-sandbox-image.sh"
CREATE_SCRIPT="${SCRIPT_DIR}/create-agent-sandbox.sh"
VERIFY_SCRIPT="${SCRIPT_DIR}/verify-agent-sandbox.sh"
RUN_SANDBOX_SCRIPT="${SCRIPT_DIR}/run-agent-sandbox.sh"
RUN_PROMPT_SCRIPT="${SCRIPT_DIR}/run-agent-prompt.sh"

for script in "${BUILD_SCRIPT}" "${CREATE_SCRIPT}" "${VERIFY_SCRIPT}" "${RUN_SANDBOX_SCRIPT}" "${RUN_PROMPT_SCRIPT}"; do
  [[ -x "${script}" ]] || { echo "FAIL: $(basename "${script}") missing or not executable" >&2; exit 1; }
done

[[ -f "${CHART_DIR}/AGENT-SELECTION.md" ]] \
  || { echo "FAIL: AGENT-SELECTION.md missing at the recipe root" >&2; exit 1; }
[[ ! -d "${CHART_DIR}/agents" ]] \
  || { echo "FAIL: agents/ folder must not exist; agent selection is the AGENT_NAME flag and agent docs live in AGENT-SELECTION.md" >&2; exit 1; }

grep -Fq 'agent_common_validate' "${BUILD_SCRIPT}"
grep -Fq 'NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0' "${BUILD_SCRIPT}"
grep -Fq 'ACTUAL_NEMOCLAW_COMMIT' "${BUILD_SCRIPT}"
grep -Fq 'NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1' "${BUILD_SCRIPT}"
grep -Fq 'umask 022' "${BUILD_SCRIPT}"
grep -Fq 'agent_common_dockerfile_rel_path' "${BUILD_SCRIPT}"
grep -Fq 'agent_common_extra_build_args' "${BUILD_SCRIPT}"

grep -Fq 'agent_common_validate' "${CREATE_SCRIPT}"
grep -Fq 'hpa_common_verify_target_node 1' "${CREATE_SCRIPT}"
grep -Fq -- '--credential OPENAI_API_KEY' "${CREATE_SCRIPT}"
grep -Fq 'hpa_common_inference_secret_contract' "${CREATE_SCRIPT}"
grep -Fq 'ACTUAL_NEMOCLAW_COMMIT' "${CREATE_SCRIPT}"
grep -Fq -- '--policy "${POLICY_FILE}"' "${CREATE_SCRIPT}"
grep -Fq 'agent_common_policy_rel_path' "${CREATE_SCRIPT}"
grep -Fq 'effective sandbox policy still permits NVIDIA-hosted inference' "${CREATE_SCRIPT}"
grep -Fq -- '-- /bin/true' "${CREATE_SCRIPT}"
grep -Fq -- '--driver-config-json "${DRIVER_CONFIG_JSON}"' "${CREATE_SCRIPT}"
grep -Fq '"node_selector": {"kubernetes.io/hostname": sys.argv[1]}' "${CREATE_SCRIPT}"
grep -Fq '"key": "nvidia.com/gpu"' "${CREATE_SCRIPT}"
grep -Fq 'hpa_common_openshell_inference_base_url' "${CREATE_SCRIPT}"
grep -Fq 'OpenShell → Envoy Gateway (LeastRequest)' "${CREATE_SCRIPT}"
grep -Fq 'Envoy LB disabled' "${CREATE_SCRIPT}"
grep -Fq -- '--no-tty -- /bin/true' "${CREATE_SCRIPT}"
grep -Fq 'agent_common_grants_nvidia_endpoint' "${CREATE_SCRIPT}"
grep -Fq -- '--remove-endpoint integrate.api.nvidia.com:443' "${CREATE_SCRIPT}"
grep -Fq 'agent_common_create_smoke_test' "${CREATE_SCRIPT}"
grep -Fq 'agent_common_create_example_query' "${CREATE_SCRIPT}"

grep -Fq 'agent_common_validate' "${VERIFY_SCRIPT}"
grep -Fq 'openclaw plugins inspect nemoclaw --json' "${VERIFY_SCRIPT}"
grep -Fq 'hermes --version' "${VERIFY_SCRIPT}"
grep -Fq 'http://localhost:8642/health' "${VERIFY_SCRIPT}"
grep -Fq 'dcode --version' "${VERIFY_SCRIPT}"
grep -Fq 'NEMOCLAW_DEEPAGENTS_CONFIG_OK' "${VERIFY_SCRIPT}"
grep -Fq 'dcode -n' "${VERIFY_SCRIPT}"
grep -Fq 'https://inference.local/v1/chat/completions' "${VERIFY_SCRIPT}"
grep -Fq 'https://inference.local/v1/models' "${VERIFY_SCRIPT}"

grep -Fq 'agent_common_validate' "${RUN_SANDBOX_SCRIPT}"
grep -Fq 'agent_common_run_mode' "${RUN_SANDBOX_SCRIPT}"
grep -Fq 'exec openshell sandbox exec' "${RUN_SANDBOX_SCRIPT}"
grep -Fq '/usr/local/bin/nemoclaw-start' "${RUN_SANDBOX_SCRIPT}"

grep -Fq 'agent_common_validate' "${RUN_PROMPT_SCRIPT}"
grep -Fq 'agent_common_run_mode' "${RUN_PROMPT_SCRIPT}"
grep -Fq 'dcode -n "${PROMPT}"' "${RUN_PROMPT_SCRIPT}"

for script in "${BUILD_SCRIPT}" "${CREATE_SCRIPT}" "${VERIFY_SCRIPT}" "${RUN_SANDBOX_SCRIPT}" "${RUN_PROMPT_SCRIPT}"; do
  if grep -Eq 'NVIDIA_API_KEY' "${script}"; then
    echo "FAIL: $(basename "${script}") native Kubernetes path contains a cloud inference API key" >&2
    exit 1
  fi
  if grep -Fq -- '--gpu' "${script}"; then
    echo "FAIL: $(basename "${script}") sandbox must not request a GPU" >&2
    exit 1
  fi
done
if grep -Fq 'integrate.api.nvidia.com' "${BUILD_SCRIPT}" "${RUN_SANDBOX_SCRIPT}" "${RUN_PROMPT_SCRIPT}"; then
  echo "FAIL: native Kubernetes path configures a cloud inference endpoint" >&2
  exit 1
fi

helm() {
  printf '%s\n' '{"inference":{"auth":{"existingSecret":"operator-inference-api.gpu-platform.production.cluster.example.internal","key":"true"}}}'
}
SECRET_CONTRACT="$(
  hpa_common_inference_secret_contract \
    test-namespace test-release test-release-metrics-proxy-inference-api
)"
if [[ "${SECRET_CONTRACT}" != $'operator-inference-api.gpu-platform.production.cluster.example.internal\ttrue' ]]; then
  echo "FAIL: scripts do not resolve the operator-managed inference Secret contract" >&2
  exit 1
fi

echo "OK: experimental NemoClaw Kubernetes path (AGENT_NAME=openclaw|hermes|deepagents) uses authenticated on-prem inference"
