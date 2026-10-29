#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Run on the DGX after agentscaling_hermes_* (OpenShell connected).
# Publishes Hermes UI :18789+i and API :8642+i so a laptop can use HTTP.
# This script binds 0.0.0.0 unless E2E_PUBLISH_BIND is set.
# Does not wait for clients. Does not print API keys.
#
#   E2E_USERS=10 ./scripts/publish-hermes-remote-http.sh
#
# If openshell-port-forward.sh dropped, those openshell forward processes
# die. Start step 5 again, then rerun this script before the laptop client.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=remote-http-clients.sh
source "${SCRIPT_DIR}/remote-http-clients.sh"

export PATH="${HOME}/.local/bin:${PATH}"
export E2E_USERS="${E2E_USERS:-10}"
export SANDBOX_PREFIX="${SANDBOX_PREFIX:-hermes-vllm-e2e-}"
export OPENSHELL_NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
OUT="${CHART_DIR}/e2e-results/hermes/remote-endpoints.json"

command -v openshell >/dev/null 2>&1 || {
  echo "ERROR: publish on the DGX with OpenShell connected (openshell-port-forward.sh attached)." >&2
  exit 1
}
openshell status >/dev/null || {
  echo "ERROR: openshell status failed. Keep ./scripts/openshell-port-forward.sh attached." >&2
  exit 1
}

export E2E_PUBLISH_BIND="${E2E_PUBLISH_BIND:-0.0.0.0}"
remote_http_publish_hermes "${E2E_USERS}" "${SANDBOX_PREFIX}" "${OUT}"
echo "Laptop UI: http://$(remote_http_advertise_host):18789/"
echo "Laptop CLI: E2E_CLIENT_HOST=$(remote_http_advertise_host) E2E_USERS=${E2E_USERS} ./scripts/client_hermes.sh"
