#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OpenShell v0.0.85 Kubernetes sandboxes intentionally boot with an idle supervisor
# command. Start the sandbox image's entrypoint for the agent selected by AGENT_NAME
# (openclaw | hermes) as the sandbox identity and keep this foreground exec session
# alive for the duration of the experimental runtime. Every gateway agent image installs
# its own start.sh as /usr/local/bin/nemoclaw-start.
#
# deepagents has no long-running gateway to start — use run-agent-prompt.sh instead.
#
# Usage:
#   cd examples/recipes/nvidia/kubernetes-gpu-autoscaling
#   AGENT_NAME=hermes ./scripts/run-agent-sandbox.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=versions.env
source "${CHART_DIR}/versions.env"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v openshell >/dev/null 2>&1 || fail "missing command: openshell"

AGENT_NAME="${AGENT_NAME:-}"
agent_common_validate "${AGENT_NAME}"
AGENT_DISPLAY_NAME="$(agent_common_display_name "${AGENT_NAME}")"
[[ "$(agent_common_run_mode "${AGENT_NAME}")" == "gateway" ]] \
  || fail "${AGENT_DISPLAY_NAME} has no long-running gateway; use AGENT_NAME=${AGENT_NAME} ./scripts/run-agent-prompt.sh \"<prompt>\" instead"

ACTUAL_OPENSHELL_VERSION="$(openshell --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
[[ "${ACTUAL_OPENSHELL_VERSION}" == "${OPENSHELL_VERSION}" ]] \
  || fail "OpenShell CLI ${OPENSHELL_VERSION} is required; found ${ACTUAL_OPENSHELL_VERSION:-unknown}"

SANDBOX_NAME="${AGENT_SANDBOX_NAME:-$(agent_common_default_sandbox_name "${AGENT_NAME}")}"
openshell sandbox get "${SANDBOX_NAME}" >/dev/null 2>&1 \
  || fail "sandbox ${SANDBOX_NAME} does not exist; run AGENT_NAME=${AGENT_NAME} ./scripts/create-agent-sandbox.sh first"

echo "Starting ${AGENT_DISPLAY_NAME} in ${SANDBOX_NAME}. Keep this terminal open."
echo "OpenShell owns the pod sandbox; the ${AGENT_DISPLAY_NAME} entrypoint runs as the sandbox identity."
exec openshell sandbox exec -n "${SANDBOX_NAME}" --no-tty -- \
  /usr/local/bin/nemoclaw-start
