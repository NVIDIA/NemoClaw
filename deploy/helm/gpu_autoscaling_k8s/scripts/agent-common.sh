#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Per-agent configuration for the generic build/create/verify/run-agent-*.sh scripts.
# Adding a fourth agent means extending the case statements below — not adding new script
# files. See ../AGENT-SELECTION.md for the agent comparison and shared policy notes.

agent_common_validate() {
  case "${1:-}" in
    openclaw | hermes | deepagents) ;;
    *)
      echo "ERROR: AGENT_NAME must be openclaw, hermes, or deepagents (got '${1:-}')" >&2
      exit 1
      ;;
  esac
}

# Local-runtime ids this recipe's Helm chart can render (ollama | vllm | nim).
# Which pairings are documented for each agent is official NemoClaw guidance —
# see ../README.md#6-e2e-test-with-multiple-end-users-and-sandboxes and
# ../../../docs/inference/choose-inference-provider.mdx.
agent_common_validate_inference_runtime() {
  case "${1:-}" in
    ollama | vllm | nim) ;;
    *)
      echo "ERROR: INFERENCE_RUNTIME must be ollama, vllm, or nim (got '${1:-}')" >&2
      exit 1
      ;;
  esac
}

# Refuse pairings official NemoClaw does not list. Deep Agents has no Local Ollama
# row; empty runtime is treated as the chart default (ollama) and is also refused.
agent_common_validate_runtime_pairing() {
  local agent="${1:?agent}"
  local runtime="${2:-}"
  agent_common_validate "${agent}"
  if [[ "${agent}" == "deepagents" && ( -z "${runtime}" || "${runtime}" == "ollama" ) ]]; then
    echo "ERROR: AGENT_NAME=deepagents with INFERENCE_RUNTIME=${runtime:-ollama} is not an officially documented pairing." >&2
    echo "Set INFERENCE_RUNTIME=vllm or nim. See README.md#6-e2e-test-with-multiple-end-users-and-sandboxes and docs/inference/choose-inference-provider.mdx." >&2
    exit 1
  fi
  if [[ -n "${runtime}" ]]; then
    agent_common_validate_inference_runtime "${runtime}"
  fi
}

# Popular documented defaults used by this recipe (OpenClaw+Ollama, Hermes+NIM, Deep Agents+vLLM).
agent_common_default_inference_model() {
  case "${1:-ollama}" in
    vllm) printf '%s' "nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8" ;;
    nim) printf '%s' "nvidia/nemotron-3-nano" ;;
    *) printf '%s' "llama3.2:3b" ;;
  esac
}

# README Quick start 6a/6b/6c pairings. TAB-separated: agent runtime model
agent_common_example_pairings() {
  printf '%s\t%s\t%s\n' \
    openclaw ollama llama3.2:3b \
    hermes nim nvidia/nemotron-3-nano \
    deepagents vllm nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8
}

# Optional pairing-test script for that agent's documented example pairing.
agent_common_example_script() {
  printf 'test-%s-%s.sh' "${1:?agent}" "${2:?runtime}"
}

agent_common_is_example_pairing() {
  local agent="${1:?agent}" runtime="${2:?runtime}" a r
  while IFS=$'\t' read -r a r _; do
    if [[ "${a}" == "${agent}" && "${r}" == "${runtime}" ]]; then
      return 0
    fi
  done < <(agent_common_example_pairings)
  return 1
}

agent_common_example_model() {
  local agent="${1:?agent}" runtime="${2:?runtime}" a r m
  while IFS=$'\t' read -r a r m; do
    if [[ "${a}" == "${agent}" && "${r}" == "${runtime}" ]]; then
      printf '%s' "${m}"
      return 0
    fi
  done < <(agent_common_example_pairings)
  return 1
}

# Pin AGENT_NAME / INFERENCE_RUNTIME / INFERENCE_MODEL to one README example.
# Used by test-openclaw-ollama.sh / test-hermes-nim.sh / test-deepagents-vllm.sh.
agent_common_pin_example_pairing() {
  local agent="${1:?agent}" runtime="${2:?runtime}" model
  model="$(agent_common_example_model "${agent}" "${runtime}")" || {
    echo "ERROR: ${agent}+${runtime} is not a README example pairing." >&2
    exit 1
  }
  if [[ -n "${AGENT_NAME:-}" && "${AGENT_NAME}" != "${agent}" ]]; then
    echo "ERROR: AGENT_NAME=${AGENT_NAME} does not match this pairing test (${agent}). Use ./scripts/test-openclaw-ollama.sh, ./scripts/test-hermes-nim.sh, or ./scripts/test-deepagents-vllm.sh." >&2
    exit 1
  fi
  if [[ -n "${INFERENCE_RUNTIME:-}" && "${INFERENCE_RUNTIME}" != "${runtime}" ]]; then
    echo "ERROR: INFERENCE_RUNTIME=${INFERENCE_RUNTIME} does not match this script (${runtime}). This script only runs ${agent}+${runtime}." >&2
    exit 1
  fi
  export AGENT_NAME="${agent}"
  export INFERENCE_RUNTIME="${runtime}"
  export INFERENCE_MODEL="${INFERENCE_MODEL:-${model}}"
  agent_common_validate_runtime_pairing "${AGENT_NAME}" "${INFERENCE_RUNTIME}"
}

agent_common_display_name() {
  case "$1" in
    openclaw) echo "NemoClaw/OpenClaw" ;;
    hermes) echo "NemoClaw/Hermes" ;;
    deepagents) echo "NemoClaw/Deep Agents Code" ;;
  esac
}

agent_common_default_sandbox_name() {
  case "$1" in
    openclaw) echo "nemoclaw-onprem" ;;
    hermes) echo "hermes-onprem" ;;
    deepagents) echo "deepagents-onprem" ;;
  esac
}

agent_common_default_provider_name() {
  case "$1" in
    openclaw) echo "onprem-ollama" ;;
    hermes) echo "onprem-hermes" ;;
    deepagents) echo "onprem-deepagents" ;;
  esac
}

# Relative to the cloned NemoClaw source root.
agent_common_dockerfile_rel_path() {
  case "$1" in
    openclaw) echo "Dockerfile" ;;
    hermes) echo "agents/hermes/Dockerfile" ;;
    deepagents) echo "agents/langchain-deepagents-code/Dockerfile" ;;
  esac
}

agent_common_base_image_repo() {
  case "$1" in
    openclaw) echo "ghcr.io/nvidia/nemoclaw/sandbox-base" ;;
    hermes) echo "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base" ;;
    deepagents) echo "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base" ;;
  esac
}

# Relative to the cloned NemoClaw source root. Despite the hermes/deepagents filename
# ("policy-additions.yaml"), all three are complete, self-contained OpenShell policies —
# not deltas merged onto another file.
agent_common_policy_rel_path() {
  case "$1" in
    openclaw) echo "nemoclaw-blueprint/policies/openclaw-sandbox.yaml" ;;
    hermes) echo "agents/hermes/policy-additions.yaml" ;;
    deepagents) echo "agents/langchain-deepagents-code/policy-additions.yaml" ;;
  esac
}

# gateway = long-running entrypoint kept alive by run-agent-sandbox.sh.
# terminal = no entrypoint to keep running; use run-agent-prompt.sh instead.
agent_common_run_mode() {
  case "$1" in
    openclaw | hermes) echo "gateway" ;;
    deepagents) echo "terminal" ;;
  esac
}

# Loopback health endpoint exposed by each long-running agent gateway.
agent_common_gateway_health_url() {
  case "$1" in
    openclaw) echo "http://localhost:18789/health" ;;
    hermes) echo "http://localhost:8642/health" ;;
    deepagents) return 1 ;;
  esac
}

# OpenClaw can exit successfully after degrading to an embedded runtime when its
# gateway is unavailable. Treat every upstream marker as a verification failure.
agent_common_output_has_embedded_fallback() {
  local output="${1:-}"
  grep -Eqi 'EMBEDDED FALLBACK|\[agent/embedded\]|fallbackFrom[": ]+gateway|transport[": ]+embedded' \
    <<<"${output}"
}

# True (exit 0) if this agent's upstream policy grants integrate.api.nvidia.com and
# create-agent-sandbox.sh must remove it, since this recipe is on-premises-only.
agent_common_grants_nvidia_endpoint() {
  case "$1" in
    openclaw | hermes) return 0 ;;
    deepagents) return 1 ;;
  esac
}

# Extra docker buildx --build-arg values beyond the shared set, one per line.
agent_common_extra_build_args() {
  local agent="${1:?agent}" model="${2:?model}"
  case "${agent}" in
    openclaw) printf '%s\n' "NEMOCLAW_PRIMARY_MODEL_REF=inference/${model}" ;;
    hermes | deepagents) ;;
  esac
}

# Fast smoke test run immediately after `openshell sandbox create` in
# create-agent-sandbox.sh. No retries/timeouts here — hpa_common_verify_target_node /
# openshell already waited for the sandbox to be Ready; verify-agent-sandbox.sh is the
# place for timeout-guarded, logged checks.
agent_common_create_smoke_test() {
  local agent="${1:?agent}" sandbox_name="${2:?sandbox_name}"
  case "${agent}" in
    openclaw)
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        openclaw plugins inspect nemoclaw --json >/dev/null
      ;;
    hermes)
      # NOT a gateway health probe: OpenShell keeps sandboxes idle (`sleep infinity`)
      # until run-agent-sandbox.sh execs nemoclaw-start in the foreground, so nothing
      # listens on Hermes's gateway port (8642) yet at this point. Mirror the deepagents
      # check below instead — confirm the build-time-generated config is present.
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        hermes --version >/dev/null
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        bash -c 'test -s /sandbox/.hermes/config.yaml && echo NEMOCLAW_HERMES_CONFIG_OK' >/dev/null
      ;;
    deepagents)
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        dcode --version >/dev/null
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        bash -c 'test -s /sandbox/.deepagents/config.toml && echo NEMOCLAW_DEEPAGENTS_CONFIG_OK' >/dev/null
      ;;
  esac
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    curl -fsS https://inference.local/v1/models >/dev/null
}

# GHCR Hermes images bake NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b.
# Point oneshot at the chart model so hermes -z does not send a missing id.
agent_common_pin_hermes_model() {
  local sandbox_name="${1:?sandbox}" model="${2:?model}"
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    hermes config set model.default "${model}" >/dev/null
}

# GHCR Deep Agents images bake NEMOCLAW_MODEL at build time (often vLLM Nemotron).
# Point dcode -n at the chart NIM model so requests match nvidia/nemotron-3-nano.
agent_common_pin_deepagents_model() {
  local sandbox_name="${1:?sandbox}" model="${2:?model}"
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    python3 -c "
import pathlib, re, sys
model = sys.argv[1].removeprefix('openai:')
path = pathlib.Path('/sandbox/.deepagents/config.toml')
text = path.read_text()
text, n = re.subn(r'(?m)^default = \".*\"\$', f'default = \"openai:{model}\"', text, count=1)
if n != 1:
    raise SystemExit('failed to set models.default')
text, n = re.subn(r'(?m)^models = \\[.*\\]\$', f'models = [\"{model}\"]', text, count=1)
if n != 1:
    raise SystemExit('failed to set provider models')
path.write_text(text)
print('NEMOCLAW_DEEPAGENTS_MODEL_OK')
" "${model}" >/dev/null
}
