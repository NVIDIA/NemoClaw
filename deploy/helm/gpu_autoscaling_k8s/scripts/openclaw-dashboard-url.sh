#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Print the OpenClaw Control UI URL (IP + port + #token=).
# Same value as `nemoclaw <sandbox> dashboard-url`. Run on the DGX.
# Does not republish or restart (restart rotates the token).
#
#   ./scripts/openclaw-dashboard-url.sh              # user 0 → :18789
#   E2E_USER=1 ./scripts/openclaw-dashboard-url.sh    # user 1 → :18790
#   E2E_USER=2 ./scripts/openclaw-dashboard-url.sh    # user 2 → :18791
#
# Treat the printed URL like a password.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=remote-http-clients.sh
source "${SCRIPT_DIR}/remote-http-clients.sh"

export PATH="${HOME}/.local/bin:${PATH}"
export KUBECONFIG="${KUBECONFIG:-${HOME}/.kube/config}"
export SANDBOX_PREFIX="${SANDBOX_PREFIX:-openclaw-ollama-e2e-}"
export OPENSHELL_NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
USER_ID="${E2E_USER:-0}"
if ! [[ "${USER_ID}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: E2E_USER must be an integer (got ${USER_ID})" >&2
  exit 1
fi

name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${USER_ID}")"
port=$((18789 + USER_ID))
host="$(remote_http_advertise_host)"
token="$(remote_http_openclaw_token "${name}")" || {
  echo "ERROR: could not read gateway.auth.token from ${name}" >&2
  echo "Is the sandbox Running? kubectl -n ${OPENSHELL_NAMESPACE} get pod ${name}" >&2
  exit 1
}

echo "http://${host}:${port}/#token=${token}"
echo "Treat this URL like a password. Leave the dashboard Password field empty." >&2
echo "?session= in the address bar after Connect is the chat thread, not this token." >&2
