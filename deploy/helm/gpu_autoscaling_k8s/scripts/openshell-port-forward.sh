#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Keep the OpenShell CLI tunnel on 127.0.0.1:8080. kubectl port-forward
# exits when the terminal closes, SSH drops, or the API connection
# resets. Then openshell fails with Connection refused (os error 111).
# This loop starts the forward again.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/openshell-port-forward.sh
#
# Leave this attached. Run agentscaling and client commands in another
# terminal after `openshell status` succeeds.

set -uo pipefail

NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
SERVICE="${OPENSHELL_SERVICE:-openshell}"
LOCAL_PORT="${OPENSHELL_LOCAL_PORT:-8080}"
REMOTE_PORT="${OPENSHELL_REMOTE_PORT:-8080}"
RETRY_SEC="${OPENSHELL_PORT_FORWARD_RETRY_SEC:-2}"

command -v kubectl >/dev/null 2>&1 || {
  echo "ERROR: missing command: kubectl" >&2
  exit 1
}

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/${LOCAL_PORT}") 2>/dev/null && exec 3>&- 3<&-
}

if port_open; then
  if command -v openshell >/dev/null 2>&1 && openshell status >/dev/null 2>&1; then
    echo "127.0.0.1:${LOCAL_PORT} already forwards to ${NAMESPACE}/service/${SERVICE}."
    echo "openshell status is ok. Keep that other process. Exiting."
    exit 0
  fi
  echo "ERROR: 127.0.0.1:${LOCAL_PORT} is in use, but openshell status failed." >&2
  echo "Stop the other listener, then rerun this script." >&2
  exit 1
fi

echo "Forwarding ${NAMESPACE}/service/${SERVICE} to 127.0.0.1:${LOCAL_PORT}."
echo "Leave this running. In another terminal: openshell status"

while true; do
  kubectl -n "${NAMESPACE}" port-forward "service/${SERVICE}" \
    "${LOCAL_PORT}:${REMOTE_PORT}" \
    || echo "port-forward exited; retrying in ${RETRY_SEC}s"
  sleep "${RETRY_SEC}"
done
