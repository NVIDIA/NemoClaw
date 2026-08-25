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
