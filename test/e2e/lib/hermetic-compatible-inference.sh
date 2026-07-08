#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared pattern for direct bash E2E jobs that need NemoClaw inference during
# onboarding but must not consume hosted NVIDIA inference secrets. This wraps the
# raw fake OpenAI-compatible server lifecycle with NemoClaw-specific environment
# exports that point onboarding at a sandbox-reachable local compatible endpoint.

# shellcheck source=test/e2e/lib/openai-compatible-api-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/openai-compatible-api-proof.sh"

nemoclaw_e2e_start_hermetic_compatible_inference() {
  local fake_key
  fake_key="${NEMOCLAW_E2E_COMPATIBLE_API_KEY:-e2e-compatible-key}"

  export FAKE_OPENAI_LOG="${FAKE_OPENAI_LOG:-$(mktemp)}"
  export FAKE_OPENAI_REQUESTS_FILE="${FAKE_OPENAI_REQUESTS_FILE:-$(mktemp)}"
  export FAKE_OPENAI_PORT="${FAKE_OPENAI_PORT:-0}"
  export FAKE_OPENAI_HOST="${FAKE_OPENAI_HOST:-0.0.0.0}"
  export FAKE_OPENAI_READY_HOST="${FAKE_OPENAI_READY_HOST:-127.0.0.1}"
  export FAKE_OPENAI_PUBLIC_HOST="${FAKE_OPENAI_PUBLIC_HOST:-host.openshell.internal}"
  export FAKE_OPENAI_MODEL="${FAKE_OPENAI_MODEL:-${NEMOCLAW_E2E_COMPATIBLE_MODEL:-test-model}}"
  export FAKE_OPENAI_API_KEY="$fake_key"
  export FAKE_OPENAI_REQUIRE_AUTH=1
  export NEMOCLAW_FAKE_OPENAI_REQUESTS_FILE="$FAKE_OPENAI_REQUESTS_FILE"

  if ! start_fake_openai_compatible_api; then
    return 1
  fi

  unset NVIDIA_INFERENCE_API_KEY NEMOCLAW_E2E_USE_HOSTED_INFERENCE
  export NEMOCLAW_PROVIDER=custom
  export NEMOCLAW_ENDPOINT_URL="$FAKE_OPENAI_BASE_URL"
  export NEMOCLAW_MODEL="$FAKE_OPENAI_MODEL"
  export NEMOCLAW_COMPAT_MODEL="$FAKE_OPENAI_MODEL"
  export NEMOCLAW_PREFERRED_API="${NEMOCLAW_E2E_PREFERRED_API:-openai-completions}"
  export COMPATIBLE_API_KEY="$fake_key"
}

nemoclaw_e2e_stop_hermetic_compatible_inference() {
  stop_fake_openai_compatible_api
}

nemoclaw_e2e_assert_hermetic_compatible_inference_used() {
  node - "${FAKE_OPENAI_REQUESTS_FILE:-}" <<'NODE'
const fs = require("fs");
const requestsFile = process.argv[2];
if (!requestsFile || !fs.existsSync(requestsFile)) {
  throw new Error(`request log missing: ${requestsFile || "<unset>"}`);
}
const entries = fs.readFileSync(requestsFile, "utf8")
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const inferencePosts = entries.filter((entry) =>
  entry.method === "POST" &&
  ["/v1/chat/completions", "/chat/completions", "/v1/responses", "/responses"].includes(entry.path),
);
if (inferencePosts.length === 0) {
  throw new Error(`expected at least one fake inference POST, got ${JSON.stringify(entries)}`);
}
const missingAuth = entries.filter((entry) => entry.auth === "missing");
if (missingAuth.length > 0) {
  throw new Error(`fake endpoint saw missing auth: ${JSON.stringify(missingAuth)}`);
}
const unauthenticated = inferencePosts.filter((entry) => entry.auth !== "ok");
if (unauthenticated.length > 0) {
  throw new Error(`fake inference POST had missing auth: ${JSON.stringify(unauthenticated)}`);
}
NODE
}
