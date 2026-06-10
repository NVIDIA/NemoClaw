#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# inference step: sandbox-inference-local
# Verifies that the sandbox can reach the `inference-local` route.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../runtime/lib" && pwd)"
# shellcheck source=../../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"
# shellcheck source=../../sandbox-exec.sh
. "${SCRIPT_DIR}/../../sandbox-exec.sh"

echo "inference:sandbox-inference-local"
e2e_context_require E2E_SANDBOX_NAME E2E_INFERENCE_ROUTE

name="$(e2e_context_get E2E_SANDBOX_NAME)"
route="$(e2e_context_get E2E_INFERENCE_ROUTE)"

# Map the route slug recorded in context.env (e.g. "inference-local")
# to the actual DNS hostname used by the OpenShell DNS+proxy inside
# the sandbox. The legacy test/e2e/ tests (test-cloud-inference-e2e.sh,
# test-bedrock-runtime-compatible-anthropic.sh, test-full-e2e.sh, ...)
# all hit the literal `inference.local` hostname — the sandbox-side
# resolver only knows that name. Interpolating the slug directly
# (`https://inference-local/...`) yields a different, non-existent DNS
# name and the gateway returns 403 because no policy widens egress
# for it.
host=""
case "${route}" in
  inference-local) host="inference.local" ;;
  *)
    echo "inference:sandbox-inference-local: unsupported E2E_INFERENCE_ROUTE '${route}'; add a slug→hostname mapping here" >&2
    exit 2
    ;;
esac

# Orchestrator step cap is 45s; widen wrapper cap to 35s.
# CodeRabbit review item #13: capture then truncate to avoid `| head` racing
# curl under `pipefail` and flagging a successful request as failed.
# shellcheck disable=SC2034 # consumed by e2e_sandbox_exec via env
E2E_SANDBOX_EXEC_TIMEOUT_SECONDS=35 \
  body="$(e2e_sandbox_exec "${name}" -- curl -fsS --max-time 25 "https://${host}/v1/models")"
printf '%s\n' "${body:0:512}"
