#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# For terminal-only agents (AGENT_NAME=deepagents — a coding harness, not a long-running
# gateway agent), run one headless prompt at a time via `dcode -n` and exit. For an
# interactive session use a terminal that supports a TTY directly with OpenShell instead:
#   openshell sandbox exec -n "${AGENT_SANDBOX_NAME:-deepagents-onprem}" -- dcode
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   AGENT_NAME=deepagents ./scripts/run-agent-prompt.sh "Explain this repository in one sentence."

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
[[ "$(agent_common_run_mode "${AGENT_NAME}")" == "terminal" ]] \
  || fail "${AGENT_DISPLAY_NAME} has a long-running gateway; use AGENT_NAME=${AGENT_NAME} ./scripts/run-agent-sandbox.sh instead"

ACTUAL_OPENSHELL_VERSION="$(openshell --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
[[ "${ACTUAL_OPENSHELL_VERSION}" == "${OPENSHELL_VERSION}" ]] \
  || fail "OpenShell CLI ${OPENSHELL_VERSION} is required; found ${ACTUAL_OPENSHELL_VERSION:-unknown}"

SANDBOX_NAME="${AGENT_SANDBOX_NAME:-$(agent_common_default_sandbox_name "${AGENT_NAME}")}"
openshell sandbox get "${SANDBOX_NAME}" >/dev/null 2>&1 \
  || fail "sandbox ${SANDBOX_NAME} does not exist; run AGENT_NAME=${AGENT_NAME} ./scripts/create-agent-sandbox.sh first"

PROMPT="${1:-}"
[[ -n "${PROMPT}" ]] || fail "usage: $0 \"<prompt text>\""

exec openshell sandbox exec -n "${SANDBOX_NAME}" --no-tty -- \
  dcode -n "${PROMPT}"
