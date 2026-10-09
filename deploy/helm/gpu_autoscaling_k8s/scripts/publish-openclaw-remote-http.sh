#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Run on the DGX after agentscaling_* (OpenShell connected).
# Publishes one host port per OpenClaw sandbox so a laptop can use HTTP.
# Public ports bind 0.0.0.0 unless E2E_PUBLISH_BIND is set.
# Does not wait for clients.
#
#   E2E_USERS=5 ./scripts/publish-openclaw-remote-http.sh
#
# Optional OpenClaw web search on the one-agent UI (sandbox 0), same as
# nemoclaw onboard. Put BRAVE_API_KEY or TAVILY_API_KEY in secrets.env:
#   NEMOCLAW_WEB_SEARCH_ENABLED=1 E2E_USERS=5 ./scripts/publish-openclaw-remote-http.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=remote-http-clients.sh
source "${SCRIPT_DIR}/remote-http-clients.sh"

export PATH="${HOME}/.local/bin:${PATH}"
export E2E_USERS="${E2E_USERS:-5}"
export SANDBOX_PREFIX="${SANDBOX_PREFIX:-openclaw-ollama-e2e-}"
export OPENSHELL_NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
OUT="${CHART_DIR}/e2e-results/openclaw-ollama/remote-endpoints.json"

command -v openshell >/dev/null 2>&1 || {
  echo "ERROR: publish on the DGX with OpenShell connected (openshell-port-forward.sh attached)." >&2
  exit 1
}
openshell status >/dev/null || {
  echo "ERROR: openshell status failed. Keep ./scripts/openshell-port-forward.sh attached." >&2
  exit 1
}

remote_http_publish_openclaw "${E2E_USERS}" "${SANDBOX_PREFIX}" "${OUT}"
