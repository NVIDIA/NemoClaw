// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSandboxConfigSyncScript,
  getInstalledOpenshellVersion,
  getStableGatewayImageRef,
  writeSandboxConfigSyncFile,
} = require("../bin/lib/onboard");

describe("onboard helpers", () => {
  it("builds a sandbox sync script that only writes nemoclaw config", () => {
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

    // Must NOT modify openclaw config from inside the sandbox — model routing
    // is handled by the host-side gateway (openshell inference set)
    assert.doesNotMatch(script, /openclaw\.json/);
    assert.doesNotMatch(script, /openclaw models set/);

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

  it("writes sandbox sync scripts to a temp file for stdin redirection", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-test-"));
    try {
      const scriptFile = writeSandboxConfigSyncFile("echo test", tmpDir, 1234);
      assert.equal(scriptFile, path.join(tmpDir, "nemoclaw-sync-1234.sh"));
      assert.equal(fs.readFileSync(scriptFile, "utf8"), "echo test\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
