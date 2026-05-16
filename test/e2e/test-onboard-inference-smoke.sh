#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Coverage guard for issue #3253 — onboard must not report installation
# success until the configured inference route has served a real request.
#
# Expected RED on main-equivalent code: PASSING inference configuration is
# treated as enough. setupInference() accepts a provider/model whose route is
# configured but whose chat/completions endpoint returns HTTP 503, so this test
# fails because setupInference() resolves successfully and prints only the route
# success line.
#
# Expected GREEN after fix: setupInference() performs a one-shot inference smoke
# probe, exits non-zero on the upstream 503, and surfaces provider/model/api
# base/credential-env diagnostics before any "Installation complete" summary.

set -euo pipefail

LOG_FILE="/tmp/nemoclaw-e2e-onboard-inference-smoke.log"
exec > >(tee "$LOG_FILE") 2>&1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
diag() { echo -e "${YELLOW}[DIAG]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  diag "onboard inference smoke log tail:"
  tail -120 "$LOG_FILE" 2>/dev/null || true
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

info "Preparing CLI build"
if [ ! -d node_modules ]; then
  npm ci --ignore-scripts
fi
npm run build:cli

info "Invoking setupInference() with a gateway route that is configured but runtime-broken"
set +e
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_ONBOARD_INFERENCE_SMOKE_E2E=1 \
  node <<'NODE' 2>&1 | tee /tmp/nemoclaw-e2e-onboard-inference-smoke-node.log
const Module = require("module");
const originalLoad = Module._load;
const calls = [];

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./adapters/openshell/resolve" || request.endsWith("/adapters/openshell/resolve")) {
    return { resolveOpenshell: () => "/usr/bin/openshell" };
  }
  if (request === "./runner" || request.endsWith("/runner")) {
    const actualRunner = originalLoad.apply(this, arguments);
    return {
      ...actualRunner,
      run: (cmd, opts = {}) => {
        calls.push(["run", cmd]);
        if (Array.isArray(cmd) && cmd.includes("provider") && cmd.includes("upsert")) {
          return { status: 0, stdout: "Created provider compatible-endpoint\n", stderr: "" };
        }
        if (Array.isArray(cmd) && cmd.includes("inference") && cmd.includes("set")) {
          return { status: 0, stdout: "Inference configured\n", stderr: "" };
        }
        if (Array.isArray(cmd) && cmd.some((part) => String(part).includes("/chat/completions"))) {
          return {
            status: 22,
            stdout: JSON.stringify({ error: { message: "upstream returned HTTP 503 from compatible-endpoint" } }),
            stderr: "curl: (22) The requested URL returned error: 503",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      runCapture: (cmd) => {
        calls.push(["runCapture", cmd]);
        if (Array.isArray(cmd) && cmd.includes("inference") && cmd.includes("get")) {
          return JSON.stringify({ provider: "compatible-endpoint", model: "broken-model" });
        }
        return "";
      },
    };
  }
  if (request === "./onboard/providers" || request.endsWith("/onboard/providers")) {
    return {
      REMOTE_PROVIDER_CONFIG: {
        custom: {
          label: "Other OpenAI-compatible endpoint",
          providerName: "compatible-endpoint",
          providerType: "openai",
          credentialEnv: "COMPATIBLE_API_KEY",
          endpointUrl: "",
          helpUrl: null,
          modelMode: "input",
          defaultModel: "",
          skipVerify: true,
        },
      },
      LOCAL_INFERENCE_PROVIDERS: [],
      providerExistsInGateway: () => true,
      getProviderLabel: (provider) => provider,
      upsertProvider: (...args) => {
        calls.push(["upsertProvider", args]);
        return { ok: true, status: 0, message: "Created provider compatible-endpoint" };
      },
    };
  }
  if (request === "./registry" || request.endsWith("/registry")) {
    return {
      updateSandbox: (_name, patch) => calls.push(["registry.updateSandbox", patch]),
      getSandbox: () => null,
      getDisabledChannels: () => [],
    };
  }
  return originalLoad.apply(this, arguments);
};

const onboard = require("./dist/lib/onboard");
const result = onboard.setupInference(
  "test-sandbox",
  "broken-model",
  "compatible-endpoint",
  "https://broken.example.invalid/v1",
  "BROKEN_API_KEY",
);

Promise.resolve(result)
  .then((value) => {
    console.log("__SETUP_INFERENCE_RESOLVED__");
    console.log(JSON.stringify(value));
    console.log("__CALLS__" + JSON.stringify(calls));
    process.exit(0);
  })
  .catch((error) => {
    console.error("__SETUP_INFERENCE_REJECTED__");
    console.error(error && error.stack ? error.stack : error);
    console.log("__CALLS__" + JSON.stringify(calls));
    process.exit(3);
  });
NODE
NODE_EXIT=$?
set -e
cat /tmp/nemoclaw-e2e-onboard-inference-smoke-node.log

info "node exit code: ${NODE_EXIT}"

if grep -q "__SETUP_INFERENCE_RESOLVED__" /tmp/nemoclaw-e2e-onboard-inference-smoke-node.log || [ "$NODE_EXIT" -eq 0 ]; then
  fail "setupInference() accepted a configured route without proving the chat/completions path; onboard would later print Installation complete while the first real request returns HTTP 503 (#3253)"
fi
pass "setupInference() did not accept a runtime-broken inference route"

if ! grep -qiE "503|upstream|compatible-endpoint|broken-model|BROKEN_API_KEY|broken.example.invalid" /tmp/nemoclaw-e2e-onboard-inference-smoke-node.log; then
  fail "onboard did not surface actionable inference smoke diagnostics (expected provider/model/api_base/credential env/upstream 503)"
fi
pass "onboard surfaced actionable inference smoke diagnostics for the broken route"
