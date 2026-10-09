#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Print the OpenClaw Control UI URL (IP + port). Run on the DGX.
# Does not republish or restart (restart rotates the token).
# The gateway token stays on this host and is not printed.
#
#   ./scripts/openclaw-dashboard-url.sh              # user 0 → :18789
#   E2E_USER=1 ./scripts/openclaw-dashboard-url.sh    # user 1 → :18790
#   E2E_USER=2 ./scripts/openclaw-dashboard-url.sh    # user 2 → :18791

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

port=$((18789 + USER_ID))
host="$(remote_http_advertise_host)"

echo "http://${host}:${port}/u/0"
echo "Leave the dashboard Password field empty. The gateway token stays on this host." >&2
echo "?session= in the address bar after Connect is the chat thread, not a gateway token." >&2
