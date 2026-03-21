// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildSandboxConfigSyncScript } = require("../bin/lib/onboard");

describe("onboard helpers", () => {
  it("builds a sandbox sync script that writes config and updates the selected model", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    assert.match(script, /cat > ~\/\.nemoclaw\/config\.json/);
    assert.match(script, /"model": "nemotron-3-nano:30b"/);
    assert.match(script, /"credentialEnv": "OPENAI_API_KEY"/);
    assert.match(script, /openclaw models set 'inference\/nemotron-3-nano:30b'/);
    assert.match(script, /inference\/nemotron-3-nano:30b/);
    assert.match(script, /^exit$/m);
  });

  it("routes ollama-local models through the inference provider", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      provider: "ollama-local",
    });

    // Primary model should be prefixed with inference/
    assert.match(script, /inference\/nemotron-3-nano:30b/);
  });

  it("generates a valid shell script with set -euo pipefail", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      model: "test-model",
      profile: "inference-local",
    });

    assert.match(script, /^set -euo pipefail$/m);
    assert.match(script, /^mkdir -p ~\/\.nemoclaw$/m);
    assert.match(script, /^exit$/m);
  });
});
