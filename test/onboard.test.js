// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSandboxConfigSyncScript,
  getInstalledOpenshellVersion,
  getStableGatewayImageRef,
} = require("../bin/lib/onboard");

describe("onboard helpers", () => {
  it("builds a sandbox sync script that writes config and sets the model", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    // Writes NemoClaw selection config to writable ~/.nemoclaw/
    assert.match(script, /cat > ~\/\.nemoclaw\/config\.json/);
    assert.match(script, /"model": "nemotron-3-nano:30b"/);
    assert.match(script, /"credentialEnv": "OPENAI_API_KEY"/);

    // Sets the active model via openclaw CLI (writes to agent config, not openclaw.json)
    assert.match(script, /openclaw models set 'inference\/nemotron-3-nano:30b'/);

    // Must NOT write to openclaw.json — it is immutable (root:root 444)
    assert.doesNotMatch(script, /openclaw\.json/);

    assert.match(script, /^exit$/m);
  });

  it("pins the gateway image to the installed OpenShell release version", () => {
    assert.equal(getInstalledOpenshellVersion("openshell 0.0.12"), "0.0.12");
    assert.equal(getInstalledOpenshellVersion("openshell 0.0.13-dev.8+gbbcaed2ea"), "0.0.13");
    assert.equal(getInstalledOpenshellVersion("bogus"), null);
    assert.equal(
      getStableGatewayImageRef("openshell 0.0.12"),
      "ghcr.io/nvidia/openshell/cluster:0.0.12"
    );
    assert.equal(getStableGatewayImageRef("openshell 0.0.13-dev.8+gbbcaed2ea"), "ghcr.io/nvidia/openshell/cluster:0.0.13");
    assert.equal(getStableGatewayImageRef("bogus"), null);
  });
});
