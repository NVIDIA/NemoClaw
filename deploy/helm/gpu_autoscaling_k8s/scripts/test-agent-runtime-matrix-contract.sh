#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Static compatibility contract for every AGENT_NAME × inference.runtime pairing. Agent
# selection configures the OpenShell sandbox, while the Helm chart configures inference;
# this test verifies each agent selection and each rendered runtime together without a
# cluster, credentials, or GPU. It does not replace the staged live matrix in README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"

command -v helm >/dev/null 2>&1 || {
  echo "helm is required" >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required" >&2
  exit 1
}

rendered_file="$(mktemp)"
trap 'rm -f "${rendered_file}"' EXIT

for agent in openclaw hermes deepagents; do
  agent_common_validate "${agent}"
  for runtime in ollama vllm nim; do
    case "${runtime}" in
      ollama)
        model="llama3.2:3b"
        runtime_args=()
        ;;
      vllm)
        model="nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8"
        runtime_args=()
        ;;
      nim)
        model="nvidia/nemotron-3-nano"
        runtime_args=(--set-string nim.ngcApiKey.value=test-only-ngc-key)
        ;;
    esac

    helm template "matrix-${agent}-${runtime}" "${CHART_DIR}" \
      -f "${CHART_DIR}/values.yaml" \
      --set ingress.allowInsecureHttp=true \
      --set ingress.auth.enabled=false \
      --set "inference.runtime=${runtime}" \
      --set-string "inference.model=${model}" \
      "${runtime_args[@]}" \
      >"${rendered_file}"

    python3 - "${rendered_file}" "${agent}" "${runtime}" <<'PYEOF'
import sys
import yaml

path, agent, runtime = sys.argv[1:]
with open(path) as stream:
    docs = [doc for doc in yaml.safe_load_all(stream) if doc]
deployment = next(doc for doc in docs if doc.get("kind") == "Deployment")
containers = deployment["spec"]["template"]["spec"]["containers"]
if len([c for c in containers if c.get("name") == runtime]) != 1:
    raise SystemExit(f"FAIL: {agent}+{runtime} did not render exactly one {runtime} container")
proxy = next(c for c in containers if c.get("name") == "metrics-proxy")
env = {entry["name"]: entry.get("value") for entry in proxy.get("env", [])}
if env.get("INFERENCE_RUNTIME") != runtime:
    raise SystemExit(
        f"FAIL: {agent}+{runtime} proxy runtime is {env.get('INFERENCE_RUNTIME')!r}"
    )
PYEOF
    echo "OK: static agent/runtime contract ${agent}+${runtime}"
  done
done
