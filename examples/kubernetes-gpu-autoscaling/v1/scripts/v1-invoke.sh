#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Official operator prompt after a successful v1 apply: openshell sandbox exec
# into fabric-agent-ctl invoke. Does not print secrets. Requires OpenShell 0.1.4
# registered to the v1 gateway with the oidc profile. development YAML cannot
# mint an operator token. Do not treat kubectl exec as this path. v0 sandboxes
# (hermes / dcode binaries) cannot run this command.

set -euo pipefail

STATE_DIR="${NEMOCLAW_V1_STATE_DIR:-}"
SANDBOX="${SANDBOX:-user-0000}"
AGENT="${AGENT:-assistant}"
export PROMPT="${PROMPT:-Reply with exactly READY.}"

usage() {
  cat <<'EOF'
Usage: NEMOCLAW_V1_STATE_DIR=/path/to/.local/gpu-autoscaling ./scripts/v1-invoke.sh

Official operator prompt through the OpenShell gateway (openshell sandbox exec).
Needs the oidc profile. development YAML has no operator token.

Optional env:
  SANDBOX   sandbox name (default user-0000)
  AGENT     YAML agent.name (default assistant)
  PROMPT    text sent as one JSON string (default: Reply with exactly READY.)

Reads fabric_agent runtime_id from $NEMOCLAW_V1_STATE_DIR/terraform.tfstate.
Does not print credential values.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${STATE_DIR}" ]]; then
  echo "Set NEMOCLAW_V1_STATE_DIR to the apply state directory." >&2
  exit 2
fi

STATE_FILE="${STATE_DIR}/terraform.tfstate"
if [[ ! -f "${STATE_FILE}" ]]; then
  echo "missing ${STATE_FILE}. Apply the v1 YAML before invoke." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v openshell >/dev/null 2>&1; then
  echo "openshell is required. v1 needs OpenShell 0.1.4, not 0.0.85." >&2
  exit 1
fi

RUNTIME_ID="$(
  jq -r --arg sandbox "${SANDBOX}" --arg agent "${AGENT}" '
    .resources[]
    | select(.type == "fabric_agent")
    | .instances[]
    | .attributes
    | select(.name == $agent or .sandbox == $sandbox)
    | .runtime_id
  ' "${STATE_FILE}" | awk 'NF{print; exit}'
)"

if [[ -z "${RUNTIME_ID}" || "${RUNTIME_ID}" == "null" ]]; then
  echo "No fabric_agent runtime_id for sandbox=${SANDBOX} agent=${AGENT} in state." >&2
  exit 1
fi

python3 -c 'import json,os,sys; json.dump(os.environ["PROMPT"], sys.stdout)' \
  | openshell sandbox exec -n "${SANDBOX}" --no-tty -- \
    fabric-agent-ctl invoke --agent "${AGENT}" --runtime-id "${RUNTIME_ID}" --input -
