// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  _setNonInteractiveForTest,
  _setPromptForTest,
  buildSandboxConfigSyncScript,
  getInstalledOpenshellVersion,
  getStableGatewayImageRef,
  promptOrDefault,
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

// Non-interactive branch: exercises env-var / default fallback logic.
describe("promptOrDefault (non-interactive)", () => {
  let savedTestPromptCustom;

  before(() => {
    savedTestPromptCustom = process.env.TEST_PROMPT_CUSTOM;
    _setNonInteractiveForTest(true);
  });

  after(() => {
    _setNonInteractiveForTest(false);
    if (savedTestPromptCustom === undefined) {
      delete process.env.TEST_PROMPT_CUSTOM;
    } else {
      process.env.TEST_PROMPT_CUSTOM = savedTestPromptCustom;
    }
  });

  it("returns custom value from env var", async () => {
    process.env.TEST_PROMPT_CUSTOM = "my-sandbox";
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    assert.equal(result, "my-sandbox");
  });

  it("falls back to defaultValue when env var is unset", async () => {
    delete process.env.TEST_PROMPT_CUSTOM;
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    assert.equal(result, "my-assistant");
  });

  it("falls back to defaultValue when env var is empty", async () => {
    process.env.TEST_PROMPT_CUSTOM = "";
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    assert.equal(result, "my-assistant");
  });

  it("falls back to defaultValue when envVar param is null", async () => {
    const result = await promptOrDefault("Name: ", null, "fallback-name");
    assert.equal(result, "fallback-name");
  });

  it("preserves valid custom name with hyphens", async () => {
    process.env.TEST_PROMPT_CUSTOM = "dev-sandbox-1";
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    assert.equal(result, "dev-sandbox-1");
  });

  it("returned value passes RFC 1123 validation when using default", async () => {
    delete process.env.TEST_PROMPT_CUSTOM;
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    assert.match(result, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it("returned value passes RFC 1123 validation with custom name", async () => {
    process.env.TEST_PROMPT_CUSTOM = "test-sandbox-42";
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    assert.match(result, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });
});

// Interactive branch: uses an injected prompt function to simulate user input.
describe("promptOrDefault (interactive)", () => {
  before(() => {
    _setNonInteractiveForTest(false);
  });

  after(() => {
    _setPromptForTest(null);
    _setNonInteractiveForTest(false);
  });

  it("falls back to defaultValue when user presses Enter (empty input)", async () => {
    _setPromptForTest(() => "");
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    assert.equal(result, "my-assistant");
  });

  it("falls back to defaultValue when user enters only whitespace", async () => {
    _setPromptForTest(() => "   ");
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    assert.equal(result, "my-assistant");
  });

  it("returns trimmed custom value when user enters padded input", async () => {
    _setPromptForTest(() => "  custom  ");
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    assert.equal(result, "custom");
  });

  it("returns user input as-is when already trimmed", async () => {
    _setPromptForTest(() => "dev-box");
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    assert.equal(result, "dev-box");
  });

  it("falls back to defaultValue when prompt returns null", async () => {
    _setPromptForTest(() => null);
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    assert.equal(result, "my-assistant");
  });
});
