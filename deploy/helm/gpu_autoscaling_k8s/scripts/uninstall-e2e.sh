#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Stop one agent e2e so another pairing can start. Removes CPU agents:
#   - OpenClaw / Hermes / Deep Agents sandboxes (e2e prefixes and pairing names)
#   - OpenShell providers (onprem-ollama / onprem-hermes / onprem-deepagents)
#
# Does not uninstall GPU inference (Ollama/vLLM/NIM), OpenShell, Envoy
# GatewayClass eg, or Prometheus. With no client and no sandboxes, nothing
# sends chats; idle HPA returns to 1 replica. The next agentscaling_* script
# helm-upgrades nemoclaw-gpu to that pairing's runtime.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   # Stop client.sh / client_hermes.sh first (Ctrl-C in that terminal).
#   ./scripts/uninstall-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
hpa_common_load_local_env "${CHART_DIR}"

export PATH="${HOME}/.local/bin:${PATH}"

E2E_SANDBOX_NS="${E2E_SANDBOX_NS:-nemoclaw-sandboxes}"

require_cmd kubectl
require_cmd python3

openshell_ok=0
if command -v openshell >/dev/null 2>&1 && openshell status >/dev/null 2>&1; then
  openshell_ok=1
else
  echo "OpenShell CLI is not connected. Keep ./scripts/openshell-port-forward.sh attached, then rerun, or this script will delete sandbox CRs/pods only."
fi

echo "Uninstalling e2e agents and sandboxes (GPU inference stays; next pairing switches the runtime)"

list_e2e_sandboxes() {
  python3 - "${E2E_SANDBOX_NS}" <<'PY'
import json, subprocess, sys

ns = sys.argv[1]
prefixes = ("openclaw-ollama-e2e-", "hermes-e2e-")
exact = {"nemoclaw-onprem", "hermes-onprem", "deepagents-onprem"}


def keep(name):
    if name in exact:
        return True
    return any(name.startswith(prefix) for prefix in prefixes)

names = set()
try:
    raw = subprocess.check_output(
        ["openshell", "sandbox", "list", "-o", "json"],
        text=True,
        stderr=subprocess.DEVNULL,
    )
    items = json.loads(raw)
    rows = items if isinstance(items, list) else (
        items.get("sandboxes") or items.get("items") or []
    )
    for item in rows:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str) and keep(name):
            names.add(name)
except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
    pass

for resource in ("sandboxes.agents.x-k8s.io", "pods"):
    try:
        raw = subprocess.check_output(
            ["kubectl", "get", resource, "-n", ns, "-o", "json"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        data = json.loads(raw)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        continue
    for item in data.get("items") or []:
        name = (item.get("metadata") or {}).get("name") or ""
        if name == "openshell-0":
            continue
        if keep(name):
            names.add(name)

for name in sorted(names):
    print(name)
PY
}

destroy_sandboxes() {
  local name
  local -a names=() pids=()
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    names+=("${name}")
  done < <(list_e2e_sandboxes)
  if ((${#names[@]} == 0)); then
    echo "  no e2e/pairing sandboxes"
    return 0
  fi
  echo "  destroying ${#names[@]} sandbox(es) (CPU agents)"
  for name in "${names[@]}"; do
    echo "    ${name}"
    (
      if [[ "${openshell_ok}" -eq 1 ]]; then
        openshell sandbox destroy "${name}" --force >/dev/null 2>&1 || true
      fi
      kubectl delete sandboxes.agents.x-k8s.io "${name}" -n "${E2E_SANDBOX_NS}" \
        --ignore-not-found --wait=false >/dev/null 2>&1 || true
      kubectl delete pod "${name}" -n "${E2E_SANDBOX_NS}" \
        --ignore-not-found --wait=false >/dev/null 2>&1 || true
    ) &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do
    wait "${pid}" || true
  done
}

delete_providers() {
  local provider
  if [[ "${openshell_ok}" -ne 1 ]]; then
    echo "  skip OpenShell provider delete (CLI not connected)"
    return 0
  fi
  echo "  deleting OpenShell providers"
  for provider in onprem-ollama onprem-hermes onprem-deepagents; do
    if openshell provider get "${provider}" >/dev/null 2>&1; then
      echo "    ${provider}"
      openshell provider delete "${provider}" >/dev/null 2>&1 || true
    fi
  done
}

destroy_sandboxes
delete_providers

echo "E2e agents and sandboxes uninstalled. OpenShell gateway, Envoy, and GPU inference stay."
echo "Idle HPA should return to 1 replica. Next: ./scripts/agentscaling_gpuutil.sh or ./scripts/agentscaling_hermes_gpuutil.sh"
