#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint for the NullHub surface.
# Starts NullHub, seeds a managed NullClaw instance wired to the
# OpenShell-managed inference.local endpoint, and exposes the local UI.

set -euo pipefail

NULLHUB_CMD=("$@")
PUBLIC_PORT="${PUBLIC_PORT:-19800}"
NULLHUB_PORT="${NULLHUB_PORT:-$PUBLIC_PORT}"
NULLHUB_INSTANCE="${NULLHUB_INSTANCE:-default}"
NULLHUB_NULLCLAW_VERSION="${NULLHUB_NULLCLAW_VERSION:-${NULLCLAW_VERSION:-v2026.3.15}}"
NULLCLAW_GATEWAY_PORT="${NULLCLAW_GATEWAY_PORT:-3000}"
NULLCLAW_MODEL="${NULLCLAW_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
NULLCLAW_PROVIDER="${NULLCLAW_PROVIDER:-custom:https://inference.local/v1}"
NULLCLAW_API_KEY="${NULLCLAW_API_KEY:-openshell-managed}"
NULLHUB_ROOT="${HOME}/.nullhub"
INSTANCE_HOME="${NULLHUB_ROOT}/instances/nullclaw/${NULLHUB_INSTANCE}"

seed_nullclaw_binary() {
  mkdir -p "${NULLHUB_ROOT}/bin"
  if [ ! -f "${NULLHUB_ROOT}/bin/nullclaw-${NULLHUB_NULLCLAW_VERSION}" ]; then
    cp "/opt/nullhub-components/nullclaw-${NULLHUB_NULLCLAW_VERSION}" "${NULLHUB_ROOT}/bin/nullclaw-${NULLHUB_NULLCLAW_VERSION}"
    chmod +x "${NULLHUB_ROOT}/bin/nullclaw-${NULLHUB_NULLCLAW_VERSION}"
  fi
}

wait_for_nullhub() {
  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${NULLHUB_PORT}/api/status" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "[nullhub] failed to become healthy" >&2
  return 1
}

start_nullhub() {
  if curl -sf "http://127.0.0.1:${NULLHUB_PORT}/api/status" > /dev/null 2>&1; then
    return 0
  fi

  nohup nullhub serve --host 0.0.0.0 --port "${NULLHUB_PORT}" > /tmp/nullhub.log 2>&1 &
  echo "[nullhub] launched (pid $!)"
  wait_for_nullhub
}

configure_nullclaw_instance() {
  local payload
  if [ -d "${INSTANCE_HOME}" ]; then
    payload=$(printf '{"home":"%s","provider":"%s","api_key":"%s","model":"%s","gateway_port":%s}' \
      "${INSTANCE_HOME}" "${NULLCLAW_PROVIDER}" "${NULLCLAW_API_KEY}" "${NULLCLAW_MODEL}" "${NULLCLAW_GATEWAY_PORT}")
    nullclaw --from-json "${payload}" > /tmp/nullhub-sync.log 2>&1
    nullhub restart "nullclaw/${NULLHUB_INSTANCE}" > /tmp/nullhub-instance.log 2>&1 || \
      nullhub start "nullclaw/${NULLHUB_INSTANCE}" > /tmp/nullhub-instance.log 2>&1
    return 0
  fi

  payload=$(printf '{"instance_name":"%s","version":"%s","provider":"%s","api_key":"%s","model":"%s","gateway_port":%s}' \
    "${NULLHUB_INSTANCE}" "${NULLHUB_NULLCLAW_VERSION}" "${NULLCLAW_PROVIDER}" "${NULLCLAW_API_KEY}" "${NULLCLAW_MODEL}" "${NULLCLAW_GATEWAY_PORT}")

  curl -fsS \
    -H 'Content-Type: application/json' \
    --data "${payload}" \
    "http://127.0.0.1:${NULLHUB_PORT}/api/wizard/nullclaw" \
    > /tmp/nullhub-install.json
}

echo "Setting up NemoClaw (NullHub surface for NullClaw)..."
mkdir -p "${HOME}/.nullhub" "${HOME}/.nullclaw"

seed_nullclaw_binary
start_nullhub
configure_nullclaw_instance

echo "[nullhub] ui: http://127.0.0.1:${PUBLIC_PORT}/"
echo "[nullhub] nullclaw instance: nullclaw/${NULLHUB_INSTANCE}"

if [ ${#NULLHUB_CMD[@]} -gt 0 ]; then
  exec "${NULLHUB_CMD[@]}"
fi
